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
final class DesktopSession: NSObject {
    enum State: Equatable {
        case connecting
        case live
        /// 视频连不上，在用 JPEG。
        case compatible
        /// 断了，正在恢复，画面停在最后一帧。
        case recovering
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
    /// 这台电脑正被别的手机看着，问过人再 `start(takeover: true)`。
    var onBusy: ((String) -> Void)?
    var onControl: ((Bool, String?) -> Void)?
    var onEnded: ((String) -> Void)?
    var onLatency: ((Int) -> Void)?

    private(set) var state: State = .connecting {
        didSet { if state != oldValue { onState?(state) } }
    }
    private(set) var quality: DesktopQuality

    private let endpoint: Endpoint
    private let computerId: String
    private var socket: URLSessionWebSocketTask?
    private var peer: RTCPeerConnection?
    private var channel: RTCDataChannel?
    private var pendingIce: [RTCIceCandidate] = []
    private var remoteSet = false
    private var stopped = true
    private var leased = false
    private var beat: Timer?
    private var deadline: Timer?
    private var grace: Timer?
    private var retry: Timer?
    private var settled: Timer?
    private var flush: Timer?
    private var ping: Timer?
    private var jpeg: Timer?
    private var attempts = 0
    private var socketFailures = 0
    private var latestMove: [String: Any]?
    private var awaitingFrame = false

    init(endpoint: Endpoint, computerId: String, quality: DesktopQuality) {
        self.endpoint = endpoint
        self.computerId = computerId
        self.quality = quality
    }

    // MARK: 开始和结束

    func start(takeover: Bool = false) {
        stopped = false
        attempts = 0
        state = .connecting
        openSocket(takeover: takeover)
    }

    func stop() {
        guard !stopped else { return }
        stopped = true
        leased = false
        send(["type": "stop"])
        closeMedia()
        for timer in [beat, deadline, grace, retry, settled, flush, ping, jpeg] { timer?.invalidate() }
        let current = socket
        socket = nil
        // 让 stop 先发出去。
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            current?.cancel(with: .goingAway, reason: nil)
        }
    }

    private func openSocket(takeover: Bool) {
        socket?.cancel(with: .goingAway, reason: nil)
        var request = URLRequest(url: endpoint.desktopURL(computer: computerId))
        endpoint.authorize(&request)
        let task = URLSession.shared.webSocketTask(with: request)
        task.maximumMessageSize = 1 << 20
        socket = task
        task.resume()
        receive(task)
        send(["type": "start", "quality": quality.rawValue, "takeover": takeover])
        beat?.invalidate()
        beat = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.leased else { return }
                self.send(["type": "beat"])
            }
        }
    }

    private func receive(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            let text: String?
            switch result {
            case .success(.string(let value)): text = value
            case .success(.data(let value)): text = String(data: value, encoding: .utf8)
            case .success: text = nil
            case .failure:
                DispatchQueue.main.async {
                    MainActor.assumeIsolated { self?.socketClosed(task) }
                }
                return
            }
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self, self.socket === task else { return }
                    if let text { self.handle(text) }
                    self.receive(task)
                }
            }
        }
    }

    /// 信令断了不等于画面断了，但心跳发不出去，电脑 12 秒后就会停，所以马上重连。
    private func socketClosed(_ task: URLSessionWebSocketTask) {
        guard socket === task, !stopped else { return }
        socket = nil
        leased = false
        socketFailures += 1
        guard socketFailures <= Self.retryDelays.count else {
            finish("连不上 Pupu 了。")
            return
        }
        state = .recovering
        schedule(after: Self.retryDelays[socketFailures - 1]) { [weak self] in
            self?.openSocket(takeover: false)
        }
    }

    private func finish(_ message: String) {
        stop()
        onEnded?(message)
    }

    private func schedule(after delay: TimeInterval, _ work: @escaping () -> Void) {
        retry?.invalidate()
        retry = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { _ in
            MainActor.assumeIsolated(work)
        }
    }

    // MARK: 信令

    private func send(_ message: [String: Any]) {
        guard let socket,
              let data = try? JSONSerialization.data(withJSONObject: message),
              let text = String(data: data, encoding: .utf8)
        else { return }
        socket.send(.string(text)) { _ in }
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = message["type"] as? String
        else { return }
        switch type {
        case "lease":
            leased = true
            socketFailures = 0
            openPeer(message["iceServers"] as? [[String: Any]] ?? [])
        case "busy":
            onBusy?(message["by"] as? String ?? "别的手机")
        case "offer":
            if let sdp = message["sdp"] as? String { answer(sdp) }
        case "ice":
            guard let candidate = message["candidate"] as? String else { return }
            let ice = RTCIceCandidate(
                sdp: candidate,
                sdpMLineIndex: (message["sdpMLineIndex"] as? NSNumber)?.int32Value ?? 0,
                sdpMid: message["sdpMid"] as? String
            )
            if remoteSet { peer?.add(ice) { _ in } } else { pendingIce.append(ice) }
        case "frame":
            awaitingFrame = false
            if let raw = message["data"] as? String, let bytes = Data(base64Encoded: raw), let image = UIImage(data: bytes) {
                onImage?(image)
            }
        case "control":
            onControl?(message["on"] as? Bool ?? false, message["message"] as? String)
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

    // MARK: WebRTC

    private func openPeer(_ servers: [[String: Any]]) {
        closeMedia()
        #if DEBUG
        // 测 JPEG 兜底用：不建连接，等 8 秒的计时走到兼容模式。
        if ProcessInfo.processInfo.environment["PUPU_FORCE_JPEG"] == "1" {
            enterCompatible()
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
        peer = Self.factory.peerConnection(with: config, constraints: constraints, delegate: self)
        deadline?.invalidate()
        deadline = Timer.scheduledTimer(withTimeInterval: 8, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.enterCompatible() }
        }
    }

    private func answer(_ sdp: String) {
        guard let peer else { return }
        let current = peer
        let description = RTCSessionDescription(type: .offer, sdp: sdp)
        nonisolated(unsafe) let unsafePeer = current
        current.setRemoteDescription(description) { [weak self] error in
            guard error == nil else { return }
            let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
            unsafePeer.answer(for: constraints) { answer, _ in
                guard let answer else { return }
                let text = answer.sdp
                unsafePeer.setLocalDescription(answer) { _ in
                    DispatchQueue.main.async {
                        MainActor.assumeIsolated {
                            guard let self, self.peer === unsafePeer else { return }
                            self.remoteSet = true
                            for ice in self.pendingIce { unsafePeer.add(ice) { _ in } }
                            self.pendingIce = []
                            self.send(["type": "answer", "sdp": text])
                        }
                    }
                }
            }
        }
    }

    private func closeMedia() {
        channel?.close()
        channel = nil
        peer?.close()
        peer = nil
        remoteSet = false
        pendingIce = []
        deadline?.invalidate()
        grace?.invalidate()
    }

    private func mediaConnected() {
        deadline?.invalidate()
        grace?.invalidate()
        jpeg?.invalidate()
        state = .live
        settled?.invalidate()
        settled = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.attempts = 0 }
        }
    }

    private func mediaLost() {
        guard !stopped else { return }
        settled?.invalidate()
        guard attempts < Self.retryDelays.count else {
            enterCompatible()
            return
        }
        state = .recovering
        let delay = Self.retryDelays[attempts]
        attempts += 1
        schedule(after: delay) { [weak self] in
            guard let self, !self.stopped else { return }
            self.send(["type": "start", "quality": self.quality.rawValue, "takeover": false])
        }
    }

    /// 一次只要一帧，收到再要下一帧，最多每秒四帧。
    private func enterCompatible() {
        guard !stopped, state != .live else { return }
        state = .compatible
        awaitingFrame = false
        jpeg?.invalidate()
        var waited = 0
        jpeg = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                waited = self.awaitingFrame ? waited + 1 : 0
                // 三秒没回当成丢了。
                guard !self.awaitingFrame || waited > 12 else { return }
                self.awaitingFrame = true
                self.send(["type": "jpeg"])
            }
        }
    }

    // MARK: 控制和输入

    func setQuality(_ value: DesktopQuality) {
        quality = value
        send(["type": "quality", "quality": value.rawValue])
    }

    func setControl(_ on: Bool) {
        send(["type": "control", "on": on])
    }

    /// 移动只留最新的一条，下一拍发出去，其他的按顺序立刻发。
    func input(_ event: [String: Any]) {
        if event["t"] as? String == "move" {
            latestMove = event
            guard flush == nil else { return }
            flush = Timer.scheduledTimer(withTimeInterval: state == .live ? 1.0 / 60 : 1.0 / 20, repeats: false) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.flush = nil
                    self.flushMove()
                }
            }
            return
        }
        flushMove()
        deliver(event)
    }

    private func flushMove() {
        guard let move = latestMove else { return }
        latestMove = nil
        deliver(move)
    }

    private func deliver(_ event: [String: Any]) {
        if let channel, channel.readyState == .open,
           let data = try? JSONSerialization.data(withJSONObject: event) {
            channel.sendData(RTCDataBuffer(data: data, isBinary: false))
            return
        }
        send(["type": "input", "event": event])
    }

    private func startPing() {
        ping?.invalidate()
        ping = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let channel = self.channel, channel.readyState == .open else { return }
                let now = ProcessInfo.processInfo.systemUptime * 1000
                if let data = try? JSONSerialization.data(withJSONObject: ["t": "ping", "c": now]) {
                    channel.sendData(RTCDataBuffer(data: data, isBinary: false))
                }
            }
        }
    }
}

// WebRTC 的回调在它自己的线程上，这里都切回主线程，状态只在主线程上动。
extension DesktopSession: RTCPeerConnectionDelegate, RTCDataChannelDelegate {
    private nonisolated func onMain(_ work: @escaping @MainActor (DesktopSession) -> Void) {
        nonisolated(unsafe) let session = self
        DispatchQueue.main.async {
            MainActor.assumeIsolated { work(session) }
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
        onMain { $0.onTrack?(video) }
    }

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        nonisolated(unsafe) let peer = peerConnection
        onMain { session in
            guard session.peer === peer else { return }
            switch newState {
            case .connected, .completed:
                session.mediaConnected()
            case .disconnected:
                session.grace?.invalidate()
                session.grace = Timer.scheduledTimer(withTimeInterval: 5, repeats: false) { [weak session] _ in
                    MainActor.assumeIsolated { session?.mediaLost() }
                }
            case .failed:
                session.mediaLost()
            default:
                break
            }
        }
    }

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        let sdp = candidate.sdp
        let mid = candidate.sdpMid
        let index = candidate.sdpMLineIndex
        onMain { session in
            session.send(["type": "ice", "candidate": sdp, "sdpMid": mid ?? NSNull(), "sdpMLineIndex": index])
        }
    }

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        dataChannel.delegate = self
        nonisolated(unsafe) let channel = dataChannel
        onMain { session in
            session.channel = channel
            session.startPing()
        }
    }

    nonisolated func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {}

    nonisolated func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        guard let message = try? JSONSerialization.jsonObject(with: buffer.data) as? [String: Any],
              message["t"] as? String == "pong", let sent = (message["c"] as? NSNumber)?.doubleValue
        else { return }
        let elapsed = Int(ProcessInfo.processInfo.systemUptime * 1000 - sent)
        onMain { $0.onLatency?(elapsed) }
    }
}
