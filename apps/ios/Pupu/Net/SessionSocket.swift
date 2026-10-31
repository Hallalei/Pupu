import Foundation

/// 跟随 Pupu 的一个 pi 会话。连上后服务端先发一份快照，之后一批批发事件；
/// 断了就退避重连，重连拿到的是新快照，所以不需要续传。
final class SessionSocket {
    enum Status: Equatable {
        case connecting, open, closed
    }

    private static let revokedCloseCode = 4003

    let session: String
    var onStatus: ((Status) -> Void)?
    var onEvents: (([JSON]) -> Void)?
    /// 项目、电脑、请示或设备变了，该重新拉一次状态。这台手机被吊销时也调，拉状态会拿到 401。
    var onChanged: (() -> Void)?
    var onError: ((String) -> Void)?

    private(set) var status: Status = .closed
    private let endpoint: Endpoint
    private var task: URLSessionWebSocketTask?
    private var loop: Task<Void, Never>?
    private var wake: CheckedContinuation<Void, Never>?
    private var activeObserver: NSObjectProtocol?

    init(endpoint: Endpoint, session: String) {
        self.endpoint = endpoint
        self.session = session
    }

    func start() {
        guard loop == nil else { return }
        activeObserver = NotificationCenter.default.addObserver(
            forName: .pupuBecameActive, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.reconnectNow() }
        }
        loop = Task { [weak self] in await self?.run() }
    }

    func stop() {
        loop?.cancel()
        loop = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        wakeUp()
        if let activeObserver { NotificationCenter.default.removeObserver(activeObserver) }
        activeObserver = nil
        setStatus(.closed)
    }

    /// 等待重连的时候，跳过剩下的退避时间。
    func reconnectNow() {
        if status == .closed { wakeUp() }
    }

    /// 空闲时开始一轮；忙的时候排在这一轮后面。
    @discardableResult
    func submit(_ text: String) -> Bool {
        send(["type": "submit", "id": UUID().uuidString, "input": text, "whenBusy": "followUp"])
    }

    @discardableResult
    func abort() -> Bool {
        send(["type": "abort", "id": UUID().uuidString])
    }

    private func send(_ message: [String: String]) -> Bool {
        guard status == .open, let task,
              let data = try? JSONSerialization.data(withJSONObject: message),
              let text = String(data: data, encoding: .utf8)
        else { return false }
        task.send(.string(text)) { _ in }
        return true
    }

    private func run() async {
        var failures = 0
        while !Task.isCancelled {
            setStatus(.connecting)
            var request = URLRequest(url: endpoint.socketURL(session: session))
            endpoint.authorize(&request)
            let task = URLSession.shared.webSocketTask(with: request)
            self.task = task
            task.resume()
            do {
                while !Task.isCancelled {
                    let message = try await task.receive()
                    if status != .open {
                        setStatus(.open)
                        failures = 0
                    }
                    if case .string(let text) = message { handle(text) }
                }
            } catch {
                task.cancel(with: .goingAway, reason: nil)
                // 4003：这台手机被吊销了（云端 protocol.ts 的 REVOKED_CLOSE_CODE）。
                if task.closeCode.rawValue == Self.revokedCloseCode { onChanged?() }
            }
            if Task.isCancelled { break }
            setStatus(.closed)
            failures += 1
            let delay = min(10, pow(2, Double(min(failures, 3))))
            await sleep(seconds: delay)
        }
    }

    private func handle(_ text: String) {
        guard let message = JSON.parse(text) else { return }
        switch message["type"]?.string {
        case "events":
            onEvents?(message["events"]?.array ?? [])
        case "projects_changed", "computers_changed", "approvals_changed", "devices_changed":
            onChanged?()
        case "error":
            onError?(message["message"]?.string ?? "出错了")
        default:
            break
        }
    }

    private func setStatus(_ next: Status) {
        guard status != next else { return }
        status = next
        onStatus?(next)
    }

    private func sleep(seconds: Double) async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            wake = continuation
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(seconds))
                self?.wakeUp()
            }
        }
    }

    private func wakeUp() {
        let continuation = wake
        wake = nil
        continuation?.resume()
    }
}
