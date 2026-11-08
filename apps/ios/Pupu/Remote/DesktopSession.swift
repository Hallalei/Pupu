import Foundation
import UIKit
import WebRTC

/// 远程桌面的画质档位，和云端 src/bridge/desktop.ts 对应。
nonisolated enum DesktopQuality: String, CaseIterable, Sendable {
    case auto, hd, saver

    var title: String {
        switch self {
        case .auto: "自动"
        case .hd: "清晰"
        case .saver: "省流"
        }
    }
}

/// 默认的解码器只声明 Constrained High 和 Constrained Baseline，而 Mac 上 Chromium 的硬件编码器只有 High（640034），
/// 两边对不上就退回软件的 OpenH264。VideoToolbox 解 High 没问题，这里多声明一条。WebRTC 在自己的线程上调它。
nonisolated final class DesktopDecoderFactory: NSObject, RTCVideoDecoderFactory {
    private let base = RTCDefaultVideoDecoderFactory()

    func createDecoder(_ info: RTCVideoCodecInfo) -> (any RTCVideoDecoder)? {
        base.createDecoder(info)
    }

    func supportedCodecs() -> [RTCVideoCodecInfo] {
        let high = RTCVideoCodecInfo(name: kRTCVideoCodecH264Name, parameters: [
            "profile-level-id": "640034",
            "level-asymmetry-allowed": "1",
            "packetization-mode": "1"
        ])
        return [high] + base.supportedCodecs()
    }
}

/// 一次远程桌面：信令走 `/api/desktop/:id` 的 WebSocket，视频和键鼠走 WebRTC 点对点，连不上时退到 JPEG。
/// 时序和重试的数值取自 Cindy 的 docs/remote-desktop.md（Apache-2.0）：心跳 3 秒，
/// 断开先等 5 秒，1、3、8 秒重试三次，连上 30 秒后重新算；8 秒还没连上先出 JPEG 画面。
///
/// 信令（`Signal`）和画面（`Picture`）各是一个状态机。每一步带着只属于它的计时器和连接，
/// 换到下一步时在 `setSignal`、`setPicture` 里收掉，带进下一步的不动。界面上的那一档从这两条算出来。
final class DesktopSession: NSObject {
    enum State: Equatable {
        case connecting
        case live
        /// 视频连不上，在用 JPEG。
        case compatible
        /// 断了，正在恢复，画面停在最后一帧。
        case recovering
    }

    /// 能不能操作这台电脑。
    enum Control: Equatable {
        case on
        /// 用户在控制面板里选了只看。
        case viewOnly
        /// 电脑那边收回了，比如没有辅助功能权限，带着电脑说的原因。下一次租约重新算。
        case refused(String?)
    }

    private enum Signal {
        /// 没在连：还没开始，或者切到后台放掉了。`start` 会重新连。
        case idle
        /// 连着，发了 start，在等租约。`failures` 是这之前连续断了几次。
        case asking(URLSessionWebSocketTask, failures: Int)
        /// 拿到了租约，每 3 秒一拍心跳；心跳停了，电脑 12 秒后就收。
        case leased(URLSessionWebSocketTask, beat: Timer)
        /// 断了，等一会儿重连。
        case redialing(failures: Int, timer: Timer)
        /// 结束了：电脑或云端结束的、重连用完了、或者用户关了。不再连。
        case ended

        var task: URLSessionWebSocketTask? {
            switch self {
            case .asking(let task, _), .leased(let task, _): task
            case .idle, .redialing, .ended: nil
            }
        }

        var timer: Timer? {
            switch self {
            case .leased(_, let timer), .redialing(_, let timer): timer
            case .idle, .asking, .ended: nil
            }
        }
    }

    private enum Picture {
        case none
        /// 点对点在协商；8 秒不通先出 JPEG。
        case negotiating(Peer, fallback: Timer)
        /// 视频通了；稳定 30 秒后，之前失败的次数不再算。
        case live(Peer, settle: Timer)
        /// 点对点断了一下，5 秒内回来就当没事。
        case faltering(Peer, grace: Timer)
        /// 点对点断了，等一会儿重新要一次租约。
        case retrying(Timer)
        /// 视频连不上，一次要一帧 JPEG，`next` 到点再要。点对点还在的话接着协商，通了换回视频。
        case stills(Peer?, next: Timer, askedAt: TimeInterval)

        var peer: Peer? {
            switch self {
            case .negotiating(let peer, _), .live(let peer, _), .faltering(let peer, _): peer
            case .stills(let peer, _, _): peer
            case .none, .retrying: nil
            }
        }

        var timer: Timer? {
            switch self {
            case .negotiating(_, let timer), .live(_, let timer), .faltering(_, let timer), .retrying(let timer): timer
            case .stills(_, let timer, _): timer
            case .none: nil
            }
        }
    }

    /// 一次点对点连接，连着它的数据通道和测延迟的 ping。关掉时一起收。
    private final class Peer {
        let connection: RTCPeerConnection
        /// 远端描述设好之前到的候选先攒着；设好以后是 nil，来了直接加。
        var early: [RTCIceCandidate]? = []
        private(set) var channel: RTCDataChannel?
        private var ping: Timer?

        init(_ connection: RTCPeerConnection) {
            self.connection = connection
        }

        func opened(_ next: RTCDataChannel) {
            channel = next
            ping?.invalidate()
            ping = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.measure() }
            }
        }

        func close() {
            ping?.invalidate()
            channel?.close()
            connection.close()
        }

        private func measure() {
            guard let channel, channel.readyState == .open,
                  let data = try? JSONSerialization.data(withJSONObject: ["t": "ping", "c": ProcessInfo.processInfo.systemUptime * 1000])
            else { return }
            channel.sendData(RTCDataBuffer(data: data, isBinary: false))
        }
    }

    private static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory(
            encoderFactory: RTCDefaultVideoEncoderFactory(),
            decoderFactory: DesktopDecoderFactory()
        )
    }()
    private static let retryDelays: [TimeInterval] = [1, 3, 8]

    var onState: ((State) -> Void)?
    var onTrack: ((RTCVideoTrack) -> Void)?
    var onImage: ((UIImage) -> Void)?
    /// 这台电脑正被别的手机看着，问过人再 `takeOver()`。
    var onBusy: ((String) -> Void)?
    var onControl: ((Control) -> Void)?
    /// 电脑或云端结束了这次远程桌面。用户自己关的不调。
    var onEnded: ((String) -> Void)?
    var onLatency: ((Int) -> Void)?

    /// 界面上显示的那一档，从信令和画面算出来，变了才告诉界面。
    private(set) var state: State = .connecting
    private(set) var quality: DesktopQuality
    private(set) var control: Control = .on {
        didSet { if control != oldValue { onControl?(control) } }
    }

    private let endpoint: Endpoint
    private let computerId: String
    private var signal: Signal = .idle
    private var picture: Picture = .none
    /// 点对点连续失败了几次。重新开始、或者视频稳定 30 秒后清零。
    private var retries = 0
    /// 还没发出去的最新一次移动，和发它的那一拍。
    private var move: (event: [String: Any], flush: Timer)?

    init(endpoint: Endpoint, computerId: String, quality: DesktopQuality) {
        self.endpoint = endpoint
        self.computerId = computerId
        self.quality = quality
    }

    // MARK: 开始和结束

    /// 打开页面、回到前台时调。已经在连就不动；结束了不再连。
    func start() {
        guard case .idle = signal else { return }
        retries = 0
        dial(failures: 0, takeover: false)
    }

    /// 别的手机正在看，用户点了接管。
    func takeOver() {
        switch signal {
        case .idle:
            retries = 0
            dial(failures: 0, takeover: true)
        case .asking(let task, _), .leased(let task, _):
            send(startMessage(takeover: true), on: task)
        case .redialing, .ended:
            break
        }
    }

    /// 切到后台：放掉租约，回来 `start` 再连。
    func pause() {
        release(then: .idle)
    }

    /// 用户关掉了，或者页面没了：放掉租约，不再连。
    func end() {
        release(then: .ended)
    }

    private func finish(_ message: String) {
        if case .ended = signal { return }
        release(then: .ended)
        onEnded?(message)
    }

    private func release(then next: Signal) {
        if case .ended = signal { return }
        if let task = signal.task {
            send(["type": "stop"], on: task)
            // 让 stop 先发出去。
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                task.cancel(with: .goingAway, reason: nil)
            }
        }
        move?.flush.invalidate()
        move = nil
        setPicture(.none)
        setSignal(next)
    }

    // MARK: 状态转移

    /// 信令换一步：上一步的计时器收掉。连接只在断线和放掉时关。
    private func setSignal(_ next: Signal) {
        let previous = signal
        signal = next
        if let timer = previous.timer, timer !== next.timer { timer.invalidate() }
        publish()
    }

    /// 画面换一步：上一步的计时器收掉，点对点连接没带进下一步的关掉。
    private func setPicture(_ next: Picture) {
        let previous = picture
        picture = next
        if let timer = previous.timer, timer !== next.timer { timer.invalidate() }
        if let peer = previous.peer, peer !== next.peer { peer.close() }
        publish()
    }

    private func publish() {
        let next = displayed
        guard next != state else { return }
        state = next
        onState?(next)
    }

    private var displayed: State {
        if case .redialing = signal { return .recovering }
        switch picture {
        case .live: return .live
        case .stills: return .compatible
        case .faltering, .retrying: return .recovering
        case .none, .negotiating:
            if case .asking(_, let failures) = signal, failures > 0 { return .recovering }
            return retries > 0 ? .recovering : .connecting
        }
    }

    private func timer(_ interval: TimeInterval, repeats: Bool = false, _ fire: @escaping @MainActor (DesktopSession) -> Void) -> Timer {
        Timer.scheduledTimer(withTimeInterval: interval, repeats: repeats) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                fire(self)
            }
        }
    }

    // MARK: 信令

    private func dial(failures: Int, takeover: Bool) {
        var request = URLRequest(url: endpoint.desktopURL(computer: computerId))
        endpoint.authorize(&request)
        let task = URLSession.shared.webSocketTask(with: request)
        task.maximumMessageSize = 1 << 20
        setSignal(.asking(task, failures: failures))
        task.resume()
        listen(task)
        send(startMessage(takeover: takeover), on: task)
    }

    private func redial() {
        guard case .redialing(let failures, _) = signal else { return }
        dial(failures: failures, takeover: false)
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
                guard let self, self.signal.task === task else { return }
                switch message {
                case .string(let text): self.handle(text)
                case .data(let data): if let text = String(data: data, encoding: .utf8) { self.handle(text) }
                @unknown default: break
                }
            }
        }
    }

    /// 信令断了不等于画面断了，但心跳发不出去，电脑 12 秒后就会停，所以马上重连。
    private func dropped(_ task: URLSessionWebSocketTask) {
        let failures: Int
        switch signal {
        case .asking(let current, let count) where current === task: failures = count + 1
        case .leased(let current, _) where current === task: failures = 1
        default: return
        }
        task.cancel(with: .goingAway, reason: nil)
        guard failures <= Self.retryDelays.count else {
            finish("连不上 Pupu 了。")
            return
        }
        // JPEG 和重要租约都要走信令，不再等它们；点对点还在的话留着，画面可能还在走。
        switch picture {
        case .stills, .retrying: setPicture(.none)
        case .none, .negotiating, .live, .faltering: break
        }
        setSignal(.redialing(failures: failures, timer: timer(Self.retryDelays[failures - 1]) { $0.redial() }))
    }

    private func send(_ message: [String: Any], on task: URLSessionWebSocketTask) {
        guard let data = try? JSONSerialization.data(withJSONObject: message),
              let text = String(data: data, encoding: .utf8)
        else { return }
        task.send(.string(text)) { _ in }
    }

    private func startMessage(takeover: Bool) -> [String: Any] {
        ["type": "start", "quality": quality.rawValue, "takeover": takeover]
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = message["type"] as? String
        else { return }
        switch type {
        case "lease":
            leased(message["iceServers"] as? [[String: Any]] ?? [])
        case "busy":
            onBusy?(message["by"] as? String ?? "别的手机")
        case "offer":
            if let sdp = message["sdp"] as? String { answer(sdp) }
        case "ice":
            guard let peer = picture.peer, let candidate = message["candidate"] as? String else { return }
            let ice = RTCIceCandidate(
                sdp: candidate,
                sdpMLineIndex: (message["sdpMLineIndex"] as? NSNumber)?.int32Value ?? 0,
                sdpMid: message["sdpMid"] as? String
            )
            if peer.early != nil { peer.early?.append(ice) } else { peer.connection.add(ice) { _ in } }
        case "frame":
            if let raw = message["data"] as? String, let bytes = Data(base64Encoded: raw), let image = UIImage(data: bytes) {
                onImage?(image)
            }
            frameArrived()
        case "control":
            computerControl(on: message["on"] as? Bool ?? false, reason: message["message"] as? String)
        case "ended":
            finish(Self.endedText(message["reason"] as? String, message["message"] as? String))
        default:
            break
        }
    }

    private static func endedText(_ reason: String?, _ message: String?) -> String {
        if let message, !message.isEmpty { return message }
        switch reason {
        case "taken_over": return "别的手机接管了这台电脑。"
        case "offline": return "这台电脑离线了。"
        case "not_allowed": return "只有这台电脑主人的手机能打开远程桌面。"
        case "screen_off": return "这台电脑关掉了「允许操作屏幕」。"
        case "needs_app": return "这台电脑要用 Pupu 电脑 App 才能远程桌面。"
        case "takeback": return "电脑上收回了控制。"
        case "expired": return "连接超时了。"
        case "capture_failed": return "这台电脑截不了屏。"
        default: return "远程桌面结束了。"
        }
    }

    /// 新租约：心跳从这一拍开始。电脑那边每次租约都从「能操作」开始，用户选了只看的再告诉它一次。画面重新协商。
    private func leased(_ servers: [[String: Any]]) {
        guard let task = signal.task else { return }
        setSignal(.leased(task, beat: timer(3, repeats: true) { $0.beat() }))
        switch control {
        case .refused: control = .on
        case .viewOnly: send(["type": "control", "on": false], on: task)
        case .on: break
        }
        openPeer(servers)
    }

    private func beat() {
        guard case .leased(let task, _) = signal else { return }
        send(["type": "beat"], on: task)
    }

    // MARK: 画面

    private func openPeer(_ servers: [[String: Any]]) {
        #if DEBUG
        // 测 JPEG 兜底用：不建连接，直接出 JPEG。
        if ProcessInfo.processInfo.environment["PUPU_FORCE_JPEG"] == "1" {
            askFrame(peer: nil)
            return
        }
        #endif
        let config = RTCConfiguration()
        config.sdpSemantics = .unifiedPlan
        config.continualGatheringPolicy = .gatherContinually
        config.iceServers = servers.compactMap { server in
            let urls = (server["urls"] as? [String]) ?? (server["urls"] as? String).map { [$0] } ?? []
            guard !urls.isEmpty else { return nil }
            return RTCIceServer(
                urlStrings: urls,
                username: server["username"] as? String,
                credential: server["credential"] as? String
            )
        }
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let connection = Self.factory.peerConnection(with: config, constraints: constraints, delegate: self) else {
            askFrame(peer: nil)
            return
        }
        setPicture(.negotiating(Peer(connection), fallback: timer(8) { $0.fallBack() }))
    }

    private func answer(_ sdp: String) {
        guard let peer = picture.peer else { return }
        nonisolated(unsafe) let connection = peer.connection
        connection.setRemoteDescription(RTCSessionDescription(type: .offer, sdp: sdp)) { [weak self] error in
            guard error == nil else { return }
            let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
            connection.answer(for: constraints) { answer, _ in
                guard let answer else { return }
                let text = answer.sdp
                connection.setLocalDescription(answer) { _ in
                    DispatchQueue.main.async {
                        MainActor.assumeIsolated { self?.answered(text, on: connection) }
                    }
                }
            }
        }
    }

    private func answered(_ sdp: String, on connection: RTCPeerConnection) {
        guard let peer = picture.peer, peer.connection === connection, let task = signal.task else { return }
        for ice in peer.early ?? [] { connection.add(ice) { _ in } }
        peer.early = nil
        send(["type": "answer", "sdp": sdp], on: task)
    }

    private func iceChanged(_ state: RTCIceConnectionState, on connection: RTCPeerConnection) {
        guard let peer = picture.peer, peer.connection === connection else { return }
        switch state {
        case .connected, .completed:
            setPicture(.live(peer, settle: timer(30) { $0.retries = 0 }))
        case .disconnected:
            switch picture {
            case .negotiating, .live: setPicture(.faltering(peer, grace: timer(5) { $0.lost() }))
            case .none, .faltering, .retrying, .stills: break
            }
        case .failed:
            lost()
        default:
            break
        }
    }

    /// 8 秒还没通：先出 JPEG，点对点接着协商。
    private func fallBack() {
        guard case .negotiating(let peer, _) = picture else { return }
        askFrame(peer: peer)
    }

    /// 点对点断了。还有重试次数就等一会儿重新要租约，用完了出 JPEG；已经在出 JPEG 的，丢掉点对点就行。
    private func lost() {
        switch picture {
        case .stills(_, let next, let askedAt):
            setPicture(.stills(nil, next: next, askedAt: askedAt))
        case .negotiating, .live, .faltering:
            guard retries < Self.retryDelays.count else {
                askFrame(peer: nil)
                return
            }
            let delay = Self.retryDelays[retries]
            retries += 1
            setPicture(.retrying(timer(delay) { $0.restartVideo() }))
        case .none, .retrying:
            break
        }
    }

    private func restartVideo() {
        guard case .retrying = picture else { return }
        setPicture(.none)
        if case .leased(let task, _) = signal { send(startMessage(takeover: false), on: task) }
    }

    /// 要一帧 JPEG。三秒没回当成丢了，再要一次。
    private func askFrame(peer: Peer?) {
        if case .leased(let task, _) = signal { send(["type": "jpeg"], on: task) }
        setPicture(.stills(peer, next: timer(3) { $0.askAgain() }, askedAt: ProcessInfo.processInfo.systemUptime))
    }

    private func askAgain() {
        guard case .stills(let peer, _, _) = picture else { return }
        askFrame(peer: peer)
    }

    /// 收到一帧：离上次要满 0.25 秒再要下一帧，最多每秒四帧。
    private func frameArrived() {
        guard case .stills(let peer, _, let askedAt) = picture else { return }
        let wait = max(0, askedAt + 0.25 - ProcessInfo.processInfo.systemUptime)
        setPicture(.stills(peer, next: timer(wait) { $0.askAgain() }, askedAt: askedAt))
    }

    // MARK: 控制和输入

    func setQuality(_ value: DesktopQuality) {
        quality = value
        if let task = signal.task { send(["type": "quality", "quality": value.rawValue], on: task) }
    }

    /// 用户选了只看，或者取消只看。取消时电脑那边的控制跟着重新打开。
    func setViewOnly(_ on: Bool) {
        control = on ? .viewOnly : .on
        if let task = signal.task { send(["type": "control", "on": !on], on: task) }
    }

    /// 电脑说控制开没开。用户选了只看的，照旧只看。
    private func computerControl(on: Bool, reason: String?) {
        switch (control, on) {
        case (.refused, true): control = .on
        case (.on, false): control = .refused(reason)
        default: break
        }
    }

    /// 移动只留最新的一条，下一拍发出去，其他的按顺序立刻发。
    func input(_ event: [String: Any]) {
        switch signal {
        case .idle, .ended: return
        case .asking, .leased, .redialing: break
        }
        guard event["t"] as? String == "move" else {
            flushMove()
            deliver(event)
            return
        }
        if let pending = move {
            move = (event, pending.flush)
            return
        }
        let interval: TimeInterval = if case .live = picture { 1.0 / 60 } else { 1.0 / 20 }
        move = (event, timer(interval) { $0.flushMove() })
    }

    private func flushMove() {
        guard let pending = move else { return }
        pending.flush.invalidate()
        move = nil
        deliver(pending.event)
    }

    private func deliver(_ event: [String: Any]) {
        if let channel = picture.peer?.channel, channel.readyState == .open,
           let data = try? JSONSerialization.data(withJSONObject: event) {
            channel.sendData(RTCDataBuffer(data: data, isBinary: false))
            return
        }
        if let task = signal.task { send(["type": "input", "event": event], on: task) }
    }
}

// WebRTC 的回调在它自己的线程上，这里都切回主线程，状态只在主线程上动。
// 每个回调都先认一下是不是现在这条点对点连接的，旧连接晚到的回调不算。
extension DesktopSession: RTCPeerConnectionDelegate, RTCDataChannelDelegate {
    private nonisolated func onMain(_ work: @escaping @MainActor (DesktopSession) -> Void) {
        DispatchQueue.main.async {
            MainActor.assumeIsolated { work(self) }
        }
    }

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    nonisolated func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd rtpReceiver: RTCRtpReceiver, streams mediaStreams: [RTCMediaStream]) {
        guard let track = rtpReceiver.track as? RTCVideoTrack else { return }
        nonisolated(unsafe) let video = track
        nonisolated(unsafe) let connection = peerConnection
        onMain { session in
            guard session.picture.peer?.connection === connection else { return }
            session.onTrack?(video)
        }
    }

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        nonisolated(unsafe) let connection = peerConnection
        onMain { $0.iceChanged(newState, on: connection) }
    }

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        let sdp = candidate.sdp
        let mid = candidate.sdpMid
        let index = candidate.sdpMLineIndex
        nonisolated(unsafe) let connection = peerConnection
        onMain { session in
            guard session.picture.peer?.connection === connection, let task = session.signal.task else { return }
            session.send(["type": "ice", "candidate": sdp, "sdpMid": mid ?? NSNull(), "sdpMLineIndex": index], on: task)
        }
    }

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        dataChannel.delegate = self
        nonisolated(unsafe) let channel = dataChannel
        nonisolated(unsafe) let connection = peerConnection
        onMain { session in
            guard let peer = session.picture.peer, peer.connection === connection else { return }
            peer.opened(channel)
        }
    }

    nonisolated func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {}

    nonisolated func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        guard let message = try? JSONSerialization.jsonObject(with: buffer.data) as? [String: Any],
              message["t"] as? String == "pong", let sent = (message["c"] as? NSNumber)?.doubleValue
        else { return }
        let elapsed = Int(ProcessInfo.processInfo.systemUptime * 1000 - sent)
        nonisolated(unsafe) let channel = dataChannel
        onMain { session in
            guard session.picture.peer?.channel === channel else { return }
            session.onLatency?(elapsed)
        }
    }
}
