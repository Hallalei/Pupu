import Foundation
import WebRTC

/// 一次远程桌面：一条 RTCPeerConnection，一路视频，一条有序的输入通道。
/// 这一端发 offer，看画面的一端回 answer。做法参考 Cindy 的 remote-desktop（Apache-2.0），
/// 视频源的喂法参考 LiveKit Swift SDK 的 ScreenCapturer（Apache-2.0）。
final class DesktopSession: NSObject {
  private let queue = DispatchQueue(label: "pupu.desktop.session")
  private var factory: RTCPeerConnectionFactory?
  private var peer: RTCPeerConnection?
  private var channel: RTCDataChannel?
  private var capture: FrameSource?
  private let input = InputInjector()

  func handle(type: String, message: [String: Any]) {
    queue.async { [self] in
      switch type {
      case "start": start(message)
      case "answer": answer(message)
      case "ice": addCandidate(message)
      case "stop": stop()
      default: break
      }
    }
  }

  func stop() {
    capture?.stop()
    capture = nil
    channel?.close()
    channel = nil
    peer?.close()
    peer = nil
  }

  private func start(_ message: [String: Any]) {
    stop()
    _ = RTCInitializeSSL()
    let factory = self.factory ?? RTCPeerConnectionFactory(
      encoderFactory: RTCDefaultVideoEncoderFactory(),
      decoderFactory: RTCDefaultVideoDecoderFactory()
    )
    self.factory = factory

    let configuration = RTCConfiguration()
    configuration.sdpSemantics = .unifiedPlan
    configuration.continualGatheringPolicy = .gatherContinually
    configuration.iceServers = iceServers(message["iceServers"])
    let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
    guard let peer = factory.peerConnection(with: configuration, constraints: constraints, delegate: self) else {
      Wire.send(["type": "error", "message": "建不了 WebRTC 连接"])
      return
    }
    self.peer = peer

    let source = factory.videoSource(forScreenCast: true)
    let track = factory.videoTrack(with: source, trackId: "screen")
    let initial = RTCRtpTransceiverInit()
    initial.direction = .sendOnly
    initial.streamIds = ["pupu-desktop"]
    guard let transceiver = peer.addTransceiver(with: track, init: initial) else {
      Wire.send(["type": "error", "message": "加不了视频轨道"])
      return
    }
    let fps = (message["fps"] as? Int).map { max(5, min(60, $0)) } ?? 30
    tune(sender: transceiver.sender, fps: fps)

    let channelConfig = RTCDataChannelConfiguration()
    channelConfig.isOrdered = true
    let channel = peer.dataChannel(forLabel: "input-v1", configuration: channelConfig)
    channel?.delegate = self
    self.channel = channel

    let maxWidth = (message["maxWidth"] as? Int).map { max(640, min(3840, $0)) } ?? 1920
    let stamp = message["stamp"] as? Bool ?? false
    let capturer = RTCVideoCapturer(delegate: source)
    let deliver: (CVPixelBuffer, Int64) -> Void = { buffer, timeStampNs in
      let frame = RTCVideoFrame(buffer: RTCCVPixelBuffer(pixelBuffer: buffer), rotation: ._0, timeStampNs: timeStampNs)
      source.capturer(capturer, didCapture: frame)
    }
    let frames: FrameSource = (message["source"] as? String) == "pattern"
      ? PatternSource(fps: fps, width: maxWidth, stamp: stamp, deliver: deliver)
      : ScreenSource(fps: fps, maxWidth: maxWidth, stamp: stamp, deliver: deliver)
    capture = frames
    frames.start { width, height, error in
      if let error {
        Wire.send(["type": "error", "message": error])
      } else {
        Wire.send(["type": "capture", "width": width, "height": height])
      }
    }

    peer.offer(for: constraints) { [weak self] description, error in
      guard let self, let description else {
        Wire.send(["type": "error", "message": "生成 offer 失败：\(error?.localizedDescription ?? "")"])
        return
      }
      self.peer?.setLocalDescription(description) { error in
        if let error {
          Wire.send(["type": "error", "message": "设置 offer 失败：\(error.localizedDescription)"])
          return
        }
        Wire.send(["type": "offer", "sdp": description.sdp])
      }
    }
  }

  /// 屏幕上多是文字，宁可掉帧也不降分辨率；码率给到 8 Mbps。
  private func tune(sender: RTCRtpSender, fps: Int) {
    let parameters = sender.parameters
    for encoding in parameters.encodings {
      encoding.maxBitrateBps = NSNumber(value: 8_000_000)
      encoding.maxFramerate = NSNumber(value: fps)
    }
    parameters.degradationPreference = NSNumber(value: RTCDegradationPreference.maintainResolution.rawValue)
    sender.parameters = parameters
  }

  private func answer(_ message: [String: Any]) {
    guard let sdp = message["sdp"] as? String else { return }
    peer?.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: sdp)) { error in
      if let error {
        Wire.send(["type": "error", "message": "设置 answer 失败：\(error.localizedDescription)"])
      }
    }
  }

  private func addCandidate(_ message: [String: Any]) {
    guard let sdp = message["candidate"] as? String, !sdp.isEmpty else { return }
    let candidate = RTCIceCandidate(
      sdp: sdp,
      sdpMLineIndex: Int32(message["sdpMLineIndex"] as? Int ?? 0),
      sdpMid: message["sdpMid"] as? String
    )
    peer?.add(candidate) { error in
      if let error {
        Wire.log("加 ICE 候选失败：\(error.localizedDescription)")
      }
    }
  }

  private func iceServers(_ raw: Any?) -> [RTCIceServer] {
    guard let list = raw as? [[String: Any]] else {
      return [RTCIceServer(urlStrings: ["stun:stun.cloudflare.com:3478"])]
    }
    return list.compactMap { item in
      let urls = (item["urls"] as? [String]) ?? (item["urls"] as? String).map { [$0] } ?? []
      guard !urls.isEmpty else { return nil }
      return RTCIceServer(
        urlStrings: urls,
        username: item["username"] as? String,
        credential: item["credential"] as? String
      )
    }
  }

  private func reply(_ payload: [String: Any]) {
    guard let channel, channel.readyState == .open,
          let data = try? JSONSerialization.data(withJSONObject: payload)
    else { return }
    _ = channel.sendData(RTCDataBuffer(data: data, isBinary: false))
  }
}

extension DesktopSession: RTCPeerConnectionDelegate {
  func peerConnection(_: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
  func peerConnection(_: RTCPeerConnection, didAdd _: RTCMediaStream) {}
  func peerConnection(_: RTCPeerConnection, didRemove _: RTCMediaStream) {}
  func peerConnectionShouldNegotiate(_: RTCPeerConnection) {}
  func peerConnection(_: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
  func peerConnection(_: RTCPeerConnection, didRemove _: [RTCIceCandidate]) {}
  func peerConnection(_: RTCPeerConnection, didOpen _: RTCDataChannel) {}

  func peerConnection(_: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
    Wire.send(["type": "state", "ice": StateName.ice(newState)])
  }

  func peerConnection(_: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
    Wire.send(["type": "state", "connection": StateName.connection(newState)])
  }

  func peerConnection(_: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
    Wire.send([
      "type": "ice",
      "candidate": candidate.sdp,
      "sdpMid": candidate.sdpMid ?? "",
      "sdpMLineIndex": Int(candidate.sdpMLineIndex)
    ])
  }
}

extension DesktopSession: RTCDataChannelDelegate {
  func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
    Wire.send(["type": "state", "channel": StateName.channel(dataChannel.readyState)])
  }

  func dataChannel(_: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
    guard let message = try? JSONSerialization.jsonObject(with: buffer.data) as? [String: Any],
          let kind = message["t"] as? String
    else { return }
    if kind == "ping" {
      // 量时钟差：看画面那一端拿它把画面上的时间戳换算成自己的时钟。
      reply(["t": "pong", "c": message["c"] ?? 0, "h": Date().timeIntervalSince1970 * 1000])
      return
    }
    input.handle(kind: kind, message: message)
  }
}

enum StateName {
  static func ice(_ state: RTCIceConnectionState) -> String {
    switch state {
    case .new: return "new"
    case .checking: return "checking"
    case .connected: return "connected"
    case .completed: return "completed"
    case .failed: return "failed"
    case .disconnected: return "disconnected"
    case .closed: return "closed"
    default: return "unknown"
    }
  }

  static func connection(_ state: RTCPeerConnectionState) -> String {
    switch state {
    case .new: return "new"
    case .connecting: return "connecting"
    case .connected: return "connected"
    case .disconnected: return "disconnected"
    case .failed: return "failed"
    case .closed: return "closed"
    default: return "unknown"
    }
  }

  static func channel(_ state: RTCDataChannelState) -> String {
    switch state {
    case .connecting: return "connecting"
    case .open: return "open"
    case .closing: return "closing"
    case .closed: return "closed"
    default: return "unknown"
    }
  }
}
