// 远程桌面验证用的输入助手：只注入鼠标键盘，不截屏、不推流。推流交给 Chrome 里的推流页。
//
// stdin 一行一个 JSON，和输入通道里的消息一样：{"t":"move","x":0.5,"y":0.5}、{"t":"key","k":"Enter"}…
// stdout：{"type":"permissions",...}、{"type":"error","message":"..."}
//
// 编译：npm run desktop:helpers

import ApplicationServices
import Foundation

Responsibility.disclaimIfNeeded()

let injector = InputInjector()
Wire.send(["type": "permissions", "accessibility": AXIsProcessTrusted()])
while let line = readLine(strippingNewline: true) {
  guard let data = line.data(using: .utf8),
        let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let kind = message["t"] as? String
  else { continue }
  injector.handle(kind: kind, message: message)
}
