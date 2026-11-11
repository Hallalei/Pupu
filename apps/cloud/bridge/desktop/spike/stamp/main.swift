// 远程桌面验证用的时间戳小窗：在屏幕右下角画一排绿块，表示现在的毫秒数，观看端靠它量截屏到显示的延迟。
// 浮在所有窗口上面，不抢焦点、不挡鼠标、不进程序坞，推流页放在后台也能量。stdin 关了就退出。
//
// 一格起始绿块、一格黑块，再加 24 位毫秒数（约 4.6 小时一轮），四周留一格黑边，和推流页里的识别对得上。
//
// 编译：npm run desktop:helpers

import AppKit

let bits = 24
let cells = bits + 2
let block: CGFloat = 12

final class StampView: NSView {
  override func draw(_ dirtyRect: NSRect) {
    let value = Int64(Date().timeIntervalSince1970 * 1000) % (1 << Int64(bits))
    NSColor.black.setFill()
    bounds.fill()
    NSColor(srgbRed: 0, green: 1, blue: 0, alpha: 1).setFill()
    for cell in 0..<cells {
      let on = cell == 0 || (cell >= 2 && (value >> Int64(bits - 1 - (cell - 2))) & 1 == 1)
      // 视图坐标从左下角算起，中间一行是格子。
      if on { NSRect(x: CGFloat(cell + 1) * block, y: block, width: block, height: block).fill() }
    }
  }

  private var frames = 0
  private var since = Date()

  @objc func tick(_ link: CADisplayLink) {
    needsDisplay = true
    // 每 5 秒报一次实际重画的帧率：ProMotion 会在画面不动时降刷新率，帧率不够截屏就跟着少帧。
    frames += 1
    let elapsed = Date().timeIntervalSince(since)
    if elapsed >= 5 {
      FileHandle.standardError.write(Data(String(format: "pupu-stamp：%.1f fps\n", Double(frames) / elapsed).utf8))
      frames = 0
      since = Date()
    }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let size = NSSize(width: CGFloat(cells + 2) * block, height: 3 * block)
// 画在带菜单栏的主屏上：推流端截的也是这块。NSScreen.main 是有焦点的那块，接了外接屏会跑偏。
let visible = NSScreen.screens.first?.visibleFrame ?? .zero
let panel = NSPanel(
  contentRect: NSRect(x: visible.maxX - size.width - 8, y: visible.minY + 8, width: size.width, height: size.height),
  styleMask: [.borderless, .nonactivatingPanel],
  backing: .buffered,
  defer: false
)
panel.level = .statusBar
panel.ignoresMouseEvents = true
panel.hasShadow = false
panel.isOpaque = true
panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
let view = StampView(frame: NSRect(origin: .zero, size: size))
panel.contentView = view
panel.orderFrontRegardless()

// 跟着屏幕刷新重画。
let link = view.displayLink(target: view, selector: #selector(StampView.tick(_:)))
// 要求 60 帧，免得 ProMotion 在画面不动时把刷新率降下来。
link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 60)
link.add(to: .main, forMode: .common)

// 拉起它的进程退出时 stdin 会关，跟着退出。
DispatchQueue.global().async {
  while readLine() != nil {}
  exit(0)
}
app.run()
