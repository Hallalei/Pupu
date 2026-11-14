import Foundation
import UIKit

/// 跟随 Pupu 的一个 pi 会话。连上后服务端先说 hello、再发一份快照，之后一批批发事件；
/// 断了就退避重连，重连拿到的是新快照，所以不需要续传。
final class SessionSocket {
    /// 一条连接从建到断的每一步。每一步带着只属于它的东西：连接本身、心跳、退避的那次等待。
    /// 离开这一步时它们在 `enter` 里一起收掉，旧的计时器碰不到后来的一步。
    private enum State {
        case stopped
        /// 握手中，或者在等服务端说 hello。`failures` 是这之前连续失败了几次。
        case connecting(URLSessionWebSocketTask, failures: Int)
        /// 服务端说过 hello 了，心跳跟着这条连接。
        case open(URLSessionWebSocketTask, heartbeat: Task<Void, Never>)
        /// 断了，等一会儿再连。`reconnectNow` 取消这次等待。
        case waiting(Task<Void, Never>, failures: Int)

        var task: URLSessionWebSocketTask? {
            switch self {
            case .connecting(let task, _), .open(let task, _): task
            case .stopped, .waiting: nil
            }
        }
    }

    /// 发出去、Pupu 还没说收下的一条消息。
    private struct Submission {
        let id: String
        let input: String
        let done: (String?) -> Void
    }

    private static let revokedCloseCode = 4003
    /// 这条会话不再给你看了（被移出空间、空间收窄），云端 protocol.ts 的 FORBIDDEN_CLOSE_CODE。别再连。
    private static let forbiddenCloseCode = 4004
    /// 心跳是固定字符串，云端用 setWebSocketAutoResponse 直接回 pong，不叫醒 Durable Object。
    /// 和电脑桥用的是同一对（云端 bridge/protocol.ts 的 BRIDGE_PING、BRIDGE_PONG）。
    private static let ping = "pupu:ping"
    private static let pong = "pupu:pong"
    private static let beatEvery: Duration = .seconds(15)
    /// 探过之后这么久什么都没收到，就当这条连接已经死了。
    private static let answerWithin: Duration = .seconds(10)

    let session: String
    var onOpenChanged: ((Bool) -> Void)?
    var onEvents: (([JSON]) -> Void)?
    /// 项目、电脑、请示或设备变了，该重新拉一次状态。这台手机被吊销时也调，拉状态会拿到 401。
    var onChanged: (() -> Void)?
    /// 电脑在做的事变了，带着整份新的。
    var onActivity: (([ComputerActivity]) -> Void)?
    /// Pupu 浏览器的一帧实时画面，只收这个会话里的。
    var onBrowserFrame: ((BrowserFrame) -> Void)?
    var onError: ((String) -> Void)?

    private let endpoint: Endpoint
    private var state: State = .stopped
    /// 收到过几帧。心跳拿它比，看探过以后有没有回音。
    private var heard = 0
    /// 还没收下的消息，按发的先后。断线时留着，重连后用同一个 id 再发，云端按 operationId 去重，不会发两遍。
    private var pending: [Submission] = []
    private var activeObserver: NSObjectProtocol?

    init(endpoint: Endpoint, session: String) {
        self.endpoint = endpoint
        self.session = session
    }

    var isOpen: Bool {
        if case .open = state { return true }
        return false
    }

    func start() {
        guard case .stopped = state else { return }
        activeObserver = NotificationCenter.default.addObserver(
            forName: .pupuBecameActive, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.reconnectNow() }
        }
        connect(failures: 0)
    }

    func stop() {
        enter(.stopped)
        pending = []
        if let activeObserver { NotificationCenter.default.removeObserver(activeObserver) }
        activeObserver = nil
    }

    /// 回到前台。在等重连就马上连；连着的话马上探一次，静默断掉的连接不用等下一拍心跳。
    func reconnectNow() {
        switch state {
        case .waiting(let sleep, _): sleep.cancel()
        case .open(let task, _): enter(.open(task, heartbeat: heartbeat(task, after: .zero)))
        case .connecting, .stopped: break
        }
    }

    /// 发一条消息。Pupu 收下了 `done(nil)`，拒了（比如今天的额度用完了）`done(原因)`。
    /// 没连着就等连上再发；发到一半断了，重连后再发一次。
    func submit(_ text: String, done: @escaping (String?) -> Void) {
        let submission = Submission(id: UUID().uuidString, input: text, done: done)
        pending.append(submission)
        if case .open(let task, _) = state { write(submission, on: task) }
    }

    func abort() {
        guard case .open(let task, _) = state else { return }
        send(["type": "abort", "id": UUID().uuidString], on: task)
    }

    // MARK: 状态转移

    /// 唯一改 state 的地方。离开的那一步的心跳和等待在这里取消；连接没带进下一步的，在这里关掉。
    private func enter(_ next: State) {
        let previous = state
        let wasOpen = isOpen
        state = next
        switch previous {
        case .stopped:
            break
        case .connecting(let task, _):
            if next.task !== task { task.cancel(with: .goingAway, reason: nil) }
        case .open(let task, let heartbeat):
            heartbeat.cancel()
            if next.task !== task { task.cancel(with: .goingAway, reason: nil) }
        case .waiting(let sleep, _):
            sleep.cancel()
        }
        if isOpen != wasOpen { onOpenChanged?(isOpen) }
    }

    private func connect(failures: Int) {
        var request = URLRequest(url: endpoint.socketURL(session: session))
        endpoint.authorize(&request)
        let task = URLSession.shared.webSocketTask(with: request)
        enter(.connecting(task, failures: failures))
        task.resume()
        listen(task)
    }

    private func listen(_ task: URLSessionWebSocketTask) {
        Task { [weak self] in
            while true {
                let message: URLSessionWebSocketTask.Message
                do {
                    message = try await task.receive()
                } catch {
                    self?.dropped(task)
                    return
                }
                guard let self, self.state.task === task else { return }
                self.received(message, on: task)
            }
        }
    }

    private func dropped(_ task: URLSessionWebSocketTask) {
        let failures: Int
        switch state {
        case .connecting(let current, let count) where current === task: failures = count + 1
        case .open(let current, _) where current === task: failures = 1
        default: return
        }
        // 4003：这台手机被吊销了（云端 protocol.ts 的 REVOKED_CLOSE_CODE）。
        if task.closeCode.rawValue == Self.revokedCloseCode { onChanged?() }
        if task.closeCode.rawValue == Self.forbiddenCloseCode {
            enter(.stopped)
            onChanged?()
            return
        }
        let delay = min(10, pow(2, Double(min(failures, 3))))
        let sleep = Task { _ = try? await Task.sleep(for: .seconds(delay)) }
        enter(.waiting(sleep, failures: failures))
        Task { [weak self] in
            await sleep.value
            self?.waited(sleep)
        }
    }

    private func waited(_ sleep: Task<Void, Never>) {
        guard case .waiting(let current, let failures) = state, current == sleep else { return }
        connect(failures: failures)
    }

    private func opened(_ task: URLSessionWebSocketTask) {
        guard case .connecting(let current, _) = state, current === task else { return }
        enter(.open(task, heartbeat: heartbeat(task, after: Self.beatEvery)))
        for submission in pending { write(submission, on: task) }
    }

    /// 过一会儿探一次：发 ping，等一会儿看收没收到东西（pong 或别的帧都算）。没收到就关掉这条连接，按断线重连。
    private func heartbeat(_ task: URLSessionWebSocketTask, after first: Duration) -> Task<Void, Never> {
        Task { [weak self] in
            var wait = first
            while true {
                try? await Task.sleep(for: wait)
                guard !Task.isCancelled, let before = self?.heard else { return }
                task.send(.string(Self.ping)) { _ in }
                try? await Task.sleep(for: Self.answerWithin)
                guard !Task.isCancelled, let after = self?.heard else { return }
                if after == before {
                    task.cancel(with: .goingAway, reason: nil)
                    return
                }
                wait = Self.beatEvery
            }
        }
    }

    // MARK: 收发

    private func received(_ message: URLSessionWebSocketTask.Message, on task: URLSessionWebSocketTask) {
        heard += 1
        guard case .string(let text) = message, text != Self.pong, let frame = JSON.parse(text) else { return }
        switch frame["type"]?.string {
        case "hello":
            opened(task)
        case "events":
            onEvents?(frame["events"]?.array ?? [])
        case "projects_changed", "computers_changed", "approvals_changed", "devices_changed":
            onChanged?()
        case "activity":
            struct Frame: Decodable { let activity: [ComputerActivity] }
            if let decoded = try? JSONDecoder().decode(Frame.self, from: Data(text.utf8)) {
                onActivity?(decoded.activity)
            }
        case "browser_frame":
            guard frame["session"]?.string == session,
                  let computerId = frame["computerId"]?.string,
                  let base64 = frame["jpeg"]?.string,
                  let data = Data(base64Encoded: base64),
                  let image = UIImage(data: data)
            else { return }
            onBrowserFrame?(BrowserFrame(computerId: computerId, image: image, url: frame["url"]?.string ?? "", title: frame["title"]?.string ?? ""))
        case "result":
            settle(frame["id"]?.string, refusal: nil)
        case "error":
            let reason = frame["message"]?.string ?? "出错了"
            if !settle(frame["id"]?.string, refusal: reason) { onError?(reason) }
        default:
            break
        }
    }

    /// 这条消息有了回音：从待收下的里拿掉，告诉发它的人。不是在等的消息返回 false。
    @discardableResult
    private func settle(_ id: String?, refusal: String?) -> Bool {
        guard let index = pending.firstIndex(where: { $0.id == id }) else { return false }
        pending.remove(at: index).done(refusal)
        return true
    }

    /// 空闲时开始一轮；忙的时候排在这一轮后面。id 同时是 operationId，再发一次云端认得出是同一条。
    private func write(_ submission: Submission, on task: URLSessionWebSocketTask) {
        send([
            "type": "submit",
            "id": submission.id,
            "operationId": submission.id,
            "input": submission.input,
            "whenBusy": "followUp"
        ], on: task)
    }

    /// 写不出去说明这条连接坏了：关掉它，按断线重连，没收下的消息重连后再发。
    private func send(_ message: [String: String], on task: URLSessionWebSocketTask) {
        guard let data = try? JSONSerialization.data(withJSONObject: message),
              let text = String(data: data, encoding: .utf8)
        else { return }
        task.send(.string(text)) { error in
            if error != nil { task.cancel(with: .goingAway, reason: nil) }
        }
    }
}

/// 浏览器任务卡片上的一帧画面：电脑 App 截的、敏感输入框已经涂掉，经云端转过来。只在内存里。
struct BrowserFrame {
    let computerId: String
    let image: UIImage
    let url: String
    let title: String
}
