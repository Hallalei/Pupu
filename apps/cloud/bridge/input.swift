// 远程桌面的输入助手：常驻，stdin 一行一个 JSON，和输入通道里的消息一样：{"t":"move","x":0.5,"y":0.5}、
// {"t":"key","k":"Enter"}。stdout 一行一个 JSON：{"type":"permissions",...}、{"type":"error","message":"..."}。
// 只注入鼠标键盘，把事件送进来的是桥，桥只在云端开了控制时才转（技术方案 6.4）。
//
// 由电脑 App 的桥拉起，辅助功能权限记在 App 名下，和 computer.swift 同一份。

import ApplicationServices
import CoreGraphics
import Foundation

func send(_ payload: [String: Any]) {
  guard var data = try? JSONSerialization.data(withJSONObject: payload) else { return }
  data.append(0x0A)
  FileHandle.standardOutput.write(data)
}

/// 把输入通道里的事件注入到这台电脑。坐标是 0 到 1 的比例，换算到主屏幕的点。
/// 双击计数、拖动用 dragged 事件、修饰键之后稍等一下，参考 Cindy 的 macos-input.swift（Apache-2.0）。
final class InputInjector {
  private let source = CGEventSource(stateID: .hidSystemState)
  private var held: CGMouseButton?
  private var lastClick: (button: CGMouseButton, at: Date, point: CGPoint, count: Int)?
  private var warned = false

  func handle(kind: String, message: [String: Any]) {
    guard AXIsProcessTrusted() else {
      if !warned {
        warned = true
        send(["type": "error", "message": "没有辅助功能权限，鼠标键盘不会生效。到系统设置 → 隐私与安全性 → 辅助功能里允许 \(ProcessInfo.processInfo.processName)。"])
      }
      return
    }
    switch kind {
    case "move":
      guard let point = point(message) else { return }
      let type: CGEventType
      switch held {
      case .left?: type = .leftMouseDragged
      case .right?: type = .rightMouseDragged
      case .some: type = .otherMouseDragged
      case nil: type = .mouseMoved
      }
      post(CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: held ?? .left))
    case "down", "up":
      guard let point = point(message) else { return }
      let button = mouseButton(message["b"] as? Int ?? 0)
      let down = kind == "down"
      let count = down ? clickCount(button, point) : (lastClick?.count ?? 1)
      let type: CGEventType
      switch button {
      case .left: type = down ? .leftMouseDown : .leftMouseUp
      case .right: type = down ? .rightMouseDown : .rightMouseUp
      default: type = down ? .otherMouseDown : .otherMouseUp
      }
      let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button)
      event?.setIntegerValueField(.mouseEventClickState, value: Int64(count))
      post(event)
      held = down ? button : nil
    case "scroll":
      let dx = Int32(max(-2000, min(2000, (message["dx"] as? Double) ?? 0)))
      let dy = Int32(max(-2000, min(2000, (message["dy"] as? Double) ?? 0)))
      // 浏览器里 deltaY 为正是往下滚，CGEvent 里为正是往上，所以取反。
      post(CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: -dy, wheel2: -dx, wheel3: 0))
    case "text":
      guard let text = message["s"] as? String, !text.isEmpty else { return }
      let units = Array(text.utf16)
      var index = 0
      while index < units.count {
        let chunk = Array(units[index..<min(units.count, index + 20)])
        for down in [true, false] {
          let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
          event?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
          post(event)
        }
        index += 20
      }
    case "key":
      guard let name = message["k"] as? String, let code = Self.keyCodes[name] else { return }
      let modifiers = (message["m"] as? [String]) ?? []
      var flags = CGEventFlags()
      for modifier in modifiers {
        switch modifier {
        case "cmd": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt": flags.insert(.maskAlternate)
        case "ctrl": flags.insert(.maskControl)
        default: break
        }
      }
      if !flags.isEmpty { usleep(8_000) }
      for down in [true, false] {
        let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
        event?.flags = flags
        post(event)
      }
    case "release":
      if let button = held, let point = CGEvent(source: nil)?.location {
        let type: CGEventType = button == .left ? .leftMouseUp : button == .right ? .rightMouseUp : .otherMouseUp
        post(CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button))
      }
      held = nil
    default:
      break
    }
  }

  private func post(_ event: CGEvent?) {
    event?.post(tap: .cghidEventTap)
  }

  private func point(_ message: [String: Any]) -> CGPoint? {
    guard let x = message["x"] as? Double, let y = message["y"] as? Double,
          x.isFinite, y.isFinite
    else { return nil }
    let bounds = CGDisplayBounds(CGMainDisplayID())
    return CGPoint(
      x: bounds.minX + max(0, min(1, x)) * (bounds.width - 1),
      y: bounds.minY + max(0, min(1, y)) * (bounds.height - 1)
    )
  }

  private func mouseButton(_ raw: Int) -> CGMouseButton {
    switch raw {
    case 2: return .right
    case 1: return .center
    default: return .left
    }
  }

  private func clickCount(_ button: CGMouseButton, _ point: CGPoint) -> Int {
    let now = Date()
    var count = 1
    if let last = lastClick, last.button == button, now.timeIntervalSince(last.at) < 0.4,
       abs(last.point.x - point.x) < 5, abs(last.point.y - point.y) < 5
    {
      count = min(3, last.count + 1)
    }
    lastClick = (button, now, point, count)
    return count
  }

  /// 网页里 KeyboardEvent.key 的名字对应的 macOS 键码。
  private static let keyCodes: [String: CGKeyCode] = [
    "Enter": 36, "Tab": 48, "Space": 49, "Backspace": 51, "Escape": 53, "Delete": 117,
    "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126,
    "Home": 115, "End": 119, "PageUp": 116, "PageDown": 121,
    "F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96, "F6": 97, "F7": 98, "F8": 100, "F9": 101, "F10": 109,
    "F11": 103, "F12": 111,
    "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4, "i": 34, "j": 38, "k": 40, "l": 37, "m": 46,
    "n": 45, "o": 31, "p": 35, "q": 12, "r": 15, "s": 1, "t": 17, "u": 32, "v": 9, "w": 13, "x": 7, "y": 16, "z": 6,
    "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25
  ]
}

let injector = InputInjector()
send(["type": "permissions", "accessibility": AXIsProcessTrusted()])
while let line = readLine(strippingNewline: true) {
  guard let data = line.data(using: .utf8),
        let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let kind = message["t"] as? String
  else { continue }
  injector.handle(kind: kind, message: message)
}
