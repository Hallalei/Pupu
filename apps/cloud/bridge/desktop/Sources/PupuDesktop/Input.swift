import ApplicationServices
import CoreGraphics
import Foundation

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
        Wire.send(["type": "error", "message": "没有辅助功能权限，鼠标键盘不会生效。到系统设置 → 隐私与安全性 → 辅助功能里允许 \(ProcessInfo.processInfo.processName)。"])
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
    "a": 0, "c": 8, "v": 9, "x": 7, "z": 6, "s": 1, "f": 3, "w": 13, "q": 12, "t": 17, "n": 45, "r": 15
  ]
}
