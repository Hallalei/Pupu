import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit

let args = Array(CommandLine.arguments.dropFirst())

func emit(_ payload: [String: Any], code: Int32) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: payload)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
    exit(code)
}

func fail(_ message: String) -> Never {
    emit(["ok": false, "error": message], code: 1)
}

func succeed(_ payload: [String: Any] = [:]) -> Never {
    var body = payload
    body["ok"] = true
    emit(body, code: 0)
}

func number(_ raw: String?) -> Double? {
    guard let raw, let value = Double(raw), value.isFinite else { return nil }
    return value
}

func trusted() -> Bool {
    AXIsProcessTrusted()
}

func requireAccessibility() {
    if !trusted() {
        fail("没有辅助功能权限。到系统设置 → 隐私与安全性 → 辅助功能，允许 pupu-computer-use，然后重开桥。")
    }
}

func point(_ x: Double, _ y: Double) -> CGPoint {
    CGPoint(x: x, y: y)
}

func mouseButton(_ name: String) -> (CGMouseButton, CGEventType, CGEventType, CGEventType) {
    switch name {
    case "right":
        return (.right, .rightMouseDown, .rightMouseUp, .rightMouseDragged)
    case "middle":
        return (.center, .otherMouseDown, .otherMouseUp, .otherMouseDragged)
    default:
        return (.left, .leftMouseDown, .leftMouseUp, .leftMouseDragged)
    }
}

func screenshot(to path: String) async {
    let image: CGImage
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let main = CGMainDisplayID()
        guard let display = content.displays.first(where: { $0.displayID == main }) ?? content.displays.first else {
            fail("截不到主屏幕。")
        }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.width = display.width
        config.height = display.height
        config.showsCursor = true
        image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    } catch {
        fail("没有屏幕录制权限，或者截不到主屏幕。到系统设置 → 隐私与安全性 → 屏幕录制，允许 pupu-computer-use，然后重开桥。")
    }
    let screenW = image.width
    let screenH = image.height
    let scale = min(1280.0 / Double(screenW), 800.0 / Double(screenH), 1)
    let width = max(1, Int((Double(screenW) * scale).rounded()))
    let height = max(1, Int((Double(screenH) * scale).rounded()))
    guard
        let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )
    else { fail("没能缩放截图。") }
    context.interpolationQuality = .medium
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let scaled = context.makeImage() else { fail("没能缩放截图。") }
    let rep = NSBitmapImageRep(cgImage: scaled)
    guard let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.6]) else {
        fail("没能把截图存成图片。")
    }
    do {
        try jpeg.write(to: URL(fileURLWithPath: path))
    } catch {
        fail("没能把截图写到磁盘。")
    }
    succeed([
        "screenWidth": screenW,
        "screenHeight": screenH,
        "width": width,
        "height": height,
        "summary": axSummary(screenW: screenW, screenH: screenH, canvasW: width, canvasH: height)
    ])
}

func axSummary(screenW: Int, screenH: Int, canvasW: Int, canvasH: Int) -> String {
    guard trusted(), let app = NSWorkspace.shared.frontmostApplication else { return "" }
    let application = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetAttributeValue(application, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    var rawWindow: CFTypeRef?
    var window = AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute as CFString, &rawWindow) == .success
        ? axElement(rawWindow)
        : nil
    if window == nil {
        var rawWindows: CFTypeRef?
        if AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &rawWindows) == .success {
            window = axElements(rawWindows).first
        }
    }
    guard let window else { return app.localizedName ?? "" }
    let windowTitle = axString(window, kAXTitleAttribute) ?? "窗口"
    var lines = ["\(app.localizedName ?? "应用") / \(windowTitle)"]
    walk(window, depth: 0, lines: &lines, screenW: screenW, screenH: screenH, canvasW: canvasW, canvasH: canvasH)
    if lines.count == 1 { lines.append("没有读出可点控件。看不见图时，先让用户把要点的东西放到前台。") }
    return lines.prefix(50).joined(separator: "\n")
}

func walk(
    _ element: AXUIElement,
    depth: Int,
    lines: inout [String],
    screenW: Int,
    screenH: Int,
    canvasW: Int,
    canvasH: Int
) {
    if lines.count >= 50 || depth > 5 { return }
    let role = axString(element, kAXRoleAttribute) ?? ""
    let title = axString(element, kAXTitleAttribute) ?? axString(element, kAXDescriptionAttribute) ?? ""
    let shown = ["AXButton", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton", "AXLink", "AXPopUpButton", "AXMenuItem", "AXStaticText"]
    if shown.contains(role), !title.isEmpty, let origin = axPoint(element), let size = axSize(element) {
        let centerX = origin.x + size.width / 2
        let centerY = origin.y + size.height / 2
        let x = Int((centerX / Double(screenW) * Double(canvasW)).rounded())
        let y = Int((centerY / Double(screenH) * Double(canvasH)).rounded())
        lines.append("\(role) \(title) @ \(x),\(y)")
    }
    var rawChildren: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &rawChildren) == .success else { return }
    for child in axElements(rawChildren).prefix(80) {
        walk(child, depth: depth + 1, lines: &lines, screenW: screenW, screenH: screenH, canvasW: canvasW, canvasH: canvasH)
    }
}

func axElement(_ raw: CFTypeRef?) -> AXUIElement? {
    guard let raw, CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
    return unsafeBitCast(raw, to: AXUIElement.self)
}

func axElements(_ raw: CFTypeRef?) -> [AXUIElement] {
    guard let raw else { return [] }
    if CFGetTypeID(raw) == AXUIElementGetTypeID() { return [unsafeBitCast(raw, to: AXUIElement.self)] }
    guard CFGetTypeID(raw) == CFArrayGetTypeID() else { return [] }
    let array = raw as! CFArray
    return (0..<CFArrayGetCount(array)).compactMap { index in
        guard let value = CFArrayGetValueAtIndex(array, index) else { return nil }
        return unsafeBitCast(value, to: AXUIElement.self)
    }
}

func axString(_ element: AXUIElement, _ name: String) -> String? {
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &raw) == .success else { return nil }
    return raw as? String
}

func axPoint(_ element: AXUIElement) -> CGPoint? {
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &raw) == .success, let raw else { return nil }
    var point = CGPoint.zero
    guard AXValueGetValue(raw as! AXValue, .cgPoint, &point) else { return nil }
    return point
}

func axSize(_ element: AXUIElement) -> CGSize? {
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &raw) == .success, let raw else { return nil }
    var size = CGSize.zero
    guard AXValueGetValue(raw as! AXValue, .cgSize, &size) else { return nil }
    return size
}

func click(x: Double, y: Double, button: String, count: Int) {
    requireAccessibility()
    let (mouse, down, up, _) = mouseButton(button)
    let whereTo = point(x, y)
    let times = min(3, max(1, count))
    for index in 1...times {
        guard
            let press = CGEvent(mouseEventSource: nil, mouseType: down, mouseCursorPosition: whereTo, mouseButton: mouse),
            let release = CGEvent(mouseEventSource: nil, mouseType: up, mouseCursorPosition: whereTo, mouseButton: mouse)
        else { fail("没能点击。") }
        press.setIntegerValueField(.mouseEventClickState, value: Int64(index))
        release.setIntegerValueField(.mouseEventClickState, value: Int64(index))
        press.post(tap: .cghidEventTap)
        usleep(20_000)
        release.post(tap: .cghidEventTap)
        usleep(40_000)
    }
    succeed()
}

func move(x: Double, y: Double) {
    requireAccessibility()
    guard let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point(x, y), mouseButton: .left) else {
        fail("没能移动鼠标。")
    }
    event.post(tap: .cghidEventTap)
    succeed()
}

func drag(x: Double, y: Double, x2: Double, y2: Double, button: String) {
    requireAccessibility()
    let (mouse, down, up, dragged) = mouseButton(button)
    let start = point(x, y)
    let end = point(x2, y2)
    guard let press = CGEvent(mouseEventSource: nil, mouseType: down, mouseCursorPosition: start, mouseButton: mouse) else {
        fail("没能开始拖动。")
    }
    press.post(tap: .cghidEventTap)
    let steps = 12
    for step in 1...steps {
        let t = Double(step) / Double(steps)
        let cursor = point(x + (x2 - x) * t, y + (y2 - y) * t)
        guard let glide = CGEvent(mouseEventSource: nil, mouseType: dragged, mouseCursorPosition: cursor, mouseButton: mouse) else {
            fail("没能拖动。")
        }
        glide.post(tap: .cghidEventTap)
        usleep(12_000)
    }
    guard let release = CGEvent(mouseEventSource: nil, mouseType: up, mouseCursorPosition: end, mouseButton: mouse) else {
        fail("没能松开鼠标。")
    }
    release.post(tap: .cghidEventTap)
    succeed()
}

func scrollOnly(x: Double, y: Double, delta: Int32) {
    requireAccessibility()
    guard let hover = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point(x, y), mouseButton: .left) else {
        fail("没能把鼠标移到滚动的位置。")
    }
    hover.post(tap: .cghidEventTap)
    guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: delta, wheel2: 0, wheel3: 0) else {
        fail("没能滚动。")
    }
    event.location = point(x, y)
    event.post(tap: .cghidEventTap)
    succeed()
}

func typeText(_ text: String) {
    requireAccessibility()
    let units = Array(text.utf16)
    var index = 0
    while index < units.count {
        let end = min(index + 8, units.count)
        let chunk = Array(units[index..<end])
        guard
            let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
            let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        else { fail("没能打字。") }
        chunk.withUnsafeBufferPointer { buffer in
            if let base = buffer.baseAddress {
                down.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: base)
                up.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: base)
            }
        }
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        usleep(8_000)
        index = end
    }
    succeed()
}

let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
    "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28,
    "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "return": 36, "enter": 36,
    "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45,
    "m": 46, ".": 47, "tab": 48, "space": 49, "`": 50, "delete": 51, "backspace": 51,
    "escape": 53, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126
]

func pressKey(_ spec: String) {
    requireAccessibility()
    var flags: CGEventFlags = []
    var token = ""
    let parts = spec.lowercased().split(separator: "+").map { String($0) }
    for part in parts {
        switch part {
        case "cmd", "command", "meta": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt", "option": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        default: token = part
        }
    }
    guard let code = keyCodes[token] else { fail("不认识这个键：\(token)。") }
    guard
        let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
        let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
    else { fail("没能按键。") }
    down.flags = flags
    up.flags = flags
    down.post(tap: .cghidEventTap)
    usleep(20_000)
    up.post(tap: .cghidEventTap)
    succeed()
}

guard let command = args.first else { fail("缺少动作。") }
switch command {
case "permissions":
    succeed(["accessibility": trusted(), "screen": CGPreflightScreenCaptureAccess()])
case "screenshot":
    guard args.count >= 2 else { fail("缺少截图路径。") }
    let output = args[1]
    let waiting = DispatchSemaphore(value: 0)
    Task {
        await screenshot(to: output)
        waiting.signal()
    }
    waiting.wait()
    fail("截图没有完成。")
case "click":
    guard let x = number(args.count > 1 ? args[1] : nil), let y = number(args.count > 2 ? args[2] : nil) else {
        fail("点击坐标不对。")
    }
    let button = args.count > 3 ? args[3] : "left"
    let count = Int(args.count > 4 ? args[4] : "1") ?? 1
    click(x: x, y: y, button: button, count: count)
case "move":
    guard let x = number(args.count > 1 ? args[1] : nil), let y = number(args.count > 2 ? args[2] : nil) else {
        fail("移动坐标不对。")
    }
    move(x: x, y: y)
case "drag":
    guard
        let x = number(args.count > 1 ? args[1] : nil),
        let y = number(args.count > 2 ? args[2] : nil),
        let x2 = number(args.count > 3 ? args[3] : nil),
        let y2 = number(args.count > 4 ? args[4] : nil)
    else { fail("拖动坐标不对。") }
    drag(x: x, y: y, x2: x2, y2: y2, button: args.count > 5 ? args[5] : "left")
case "scroll":
    guard
        let x = number(args.count > 1 ? args[1] : nil),
        let y = number(args.count > 2 ? args[2] : nil),
        let delta = number(args.count > 3 ? args[3] : nil)
    else { fail("滚动参数不对。") }
    scrollOnly(x: x, y: y, delta: Int32(delta.rounded()))
case "type":
    let text = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? ""
    if text.isEmpty { fail("没有要输入的文字。") }
    typeText(text)
case "key":
    guard args.count >= 2 else { fail("缺少键名。") }
    pressKey(args[1])
default:
    fail("不认识这个屏幕动作。")
}
