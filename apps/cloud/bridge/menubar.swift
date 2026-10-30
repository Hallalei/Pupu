// Pupu 在这台电脑菜单栏上的图标。
//
// 桥（Node）管状态和文案，每次变化往 stdin 写一行完整的 JSON；这个程序只管图标和菜单，
// 用户点了什么写一行 JSON 到 stdout。stdin 关了就退出，桥会在需要时再拉起来。
//
// 用 `swiftc -parse-as-library` 编译，入口是下面的 @main。做法参考 Cindy 的
// apps/desktop/native/menubar/macos-menubar-helper.swift（Apache-2.0）。

import AppKit

struct MenubarState: Decodable {
  let status: String
  let title: String
  let lines: [String]
  let screenGrant: Bool
  let jobs: Int
  let allowCommands: Bool
  let allowScreen: Bool
  let url: String
  let name: String
}

enum Output {
  static func send(_ payload: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: payload) else { return }
    data.append(0x0A)
    FileHandle.standardOutput.write(data)
  }

  /// 写到桥的日志里，排查用。
  static func log(_ message: String) {
    FileHandle.standardError.write(Data("菜单栏：\(message)\n".utf8))
  }
}

@MainActor
final class StatusController: NSObject, NSMenuDelegate {
  private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let menu = NSMenu()
  private var state: MenubarState?
  private var reported = false

  override init() {
    super.init()
    menu.delegate = self
    menu.autoenablesItems = false
    item.menu = menu
    item.button?.setAccessibilityLabel("Pupu")
    render()
  }

  func apply(_ next: MenubarState) {
    state = next
    render()
    if !reported {
      reported = true
      Output.log("图标已显示（\(next.status)），\(item.button?.image == nil ? "用的是文字" : "用的是 SF Symbol")")
    }
  }

  private func render() {
    guard let button = item.button else { return }
    let status = state?.status ?? "offline"
    let image = Self.icon(for: status)
    button.image = image
    // 系统里找不到这些 SF Symbol 时退回文字，免得图标是空的。
    button.title = image == nil ? "Pupu" : ""
    button.appearsDisabled = status == "offline"
    button.toolTip = state.map { "Pupu · \($0.name)：\($0.title)" } ?? "Pupu：桥还没连上"
    rebuildMenu()
  }

  /// 菜单栏图标按惯例用模板图，跟着系统深浅色和高亮状态走。
  private static func icon(for status: String) -> NSImage? {
    let names: [String]
    switch status {
    case "waiting": names = ["hand.raised.fill", "exclamationmark.circle.fill"]
    case "screen": names = ["cursorarrow.rays", "cursorarrow.click.2", "cursorarrow"]
    case "busy": names = ["pawprint.fill", "terminal.fill"]
    case "idle": names = ["pawprint", "circle"]
    default: names = ["pawprint", "circle.dashed"]
    }
    for name in names {
      if let image = NSImage(systemSymbolName: name, accessibilityDescription: "Pupu") {
        let configured = image.withSymbolConfiguration(.init(pointSize: 14, weight: .regular)) ?? image
        configured.isTemplate = true
        return configured
      }
    }
    return nil
  }

  private func rebuildMenu() {
    menu.removeAllItems()
    guard let state else {
      menu.addItem(disabled("Pupu：桥还没连上"))
      return
    }
    menu.addItem(disabled("Pupu · \(state.name)"))
    menu.addItem(disabled(state.title))
    for line in state.lines.prefix(8) {
      menu.addItem(disabled("  \(line)"))
    }
    menu.addItem(.separator())

    let takeback = action("收回屏幕控制", #selector(takeBack))
    takeback.isEnabled = state.screenGrant || state.status == "screen"
    menu.addItem(takeback)
    let stop = action(state.jobs > 0 ? "停止正在跑的命令（\(state.jobs) 条）" : "停止正在跑的命令", #selector(stopJobs))
    stop.isEnabled = state.jobs > 0
    menu.addItem(stop)
    menu.addItem(.separator())

    let commands = action("允许跑命令和写文件", #selector(toggleCommands))
    commands.state = state.allowCommands ? .on : .off
    menu.addItem(commands)
    let screen = action("允许操作屏幕", #selector(toggleScreen))
    screen.state = state.allowScreen ? .on : .off
    menu.addItem(screen)
    menu.addItem(.separator())

    let open = action("打开 Pupu", #selector(openPupu))
    open.isEnabled = URL(string: state.url) != nil
    menu.addItem(open)
  }

  private func disabled(_ title: String) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    item.isEnabled = false
    return item
  }

  private func action(_ title: String, _ selector: Selector) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: selector, keyEquivalent: "")
    item.target = self
    return item
  }

  @objc private func takeBack() {
    Output.send(["action": "takeback"])
  }

  @objc private func stopJobs() {
    Output.send(["action": "stopJobs"])
  }

  @objc private func toggleCommands() {
    guard let state else { return }
    Output.send(["action": "setAllowCommands", "value": !state.allowCommands])
  }

  @objc private func toggleScreen() {
    guard let state else { return }
    Output.send(["action": "setAllowScreen", "value": !state.allowScreen])
  }

  @objc private func openPupu() {
    guard let state, let url = URL(string: state.url) else { return }
    NSWorkspace.shared.open(url)
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var controller: StatusController?

  func applicationDidFinishLaunching(_ notification: Notification) {
    MainActor.assumeIsolated {
      controller = StatusController()
    }
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      let decoder = JSONDecoder()
      while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8), let state = try? decoder.decode(MenubarState.self, from: data) else {
          continue
        }
        DispatchQueue.main.async {
          MainActor.assumeIsolated { self?.controller?.apply(state) }
        }
      }
      // 桥退出或者不要这个图标了。
      DispatchQueue.main.async { NSApp.terminate(nil) }
    }
  }
}

@main
enum PupuMenubar {
  static func main() {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    withExtendedLifetime(delegate) { app.run() }
  }
}
