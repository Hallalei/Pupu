// pupu-desktop：把这台电脑的屏幕用 WebRTC 推出去，收手机发来的鼠标键盘。
//
// 桥（Node）管信令：往 stdin 写一行一个 JSON，从 stdout 读一行一个 JSON。视频和输入走 WebRTC，
// 不经过桥和云端。stdin 关了就退出。
//
// stdin：
//   {"type":"start","source":"screen"|"pattern","fps":30,"maxWidth":1920,"stamp":true,"iceServers":[...]}
//   {"type":"answer","sdp":"..."}
//   {"type":"ice","candidate":"...","sdpMid":"0","sdpMLineIndex":0}
//   {"type":"stop"}
// stdout：
//   {"type":"offer","sdp":"..."}、{"type":"ice",...}、{"type":"state",...}、{"type":"capture",...}、
//   {"type":"permissions",...}、{"type":"error","message":"..."}

import ApplicationServices
import CoreGraphics
import Foundation

@main
enum PupuDesktop {
  static func main() {
    // 让系统把屏幕录制、辅助功能的授权记在 pupu-desktop 自己名下，
    // 而不是记在拉起它的终端、Claude 或 node 名下。
    Responsibility.disclaimIfNeeded()

    let session = DesktopSession()
    Wire.send([
      "type": "permissions",
      "screen": CGPreflightScreenCaptureAccess(),
      "accessibility": AXIsProcessTrusted()
    ])
    DispatchQueue.global(qos: .userInitiated).async {
      while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8),
              let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = message["type"] as? String
        else { continue }
        session.handle(type: type, message: message)
      }
      session.stop()
      exit(0)
    }
    dispatchMain()
  }
}
