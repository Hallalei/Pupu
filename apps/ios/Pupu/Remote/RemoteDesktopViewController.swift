import LocalAuthentication
import UIKit
import WebRTC

/// 远程桌面的全屏页。排法照 Cindy 的 Mobile viewer（docs/remote-desktop.md，Apache-2.0）：
/// 四个工具「所有窗口、桌面、键盘、控制」，竖屏在底部，横屏在侧边；竖屏左上角有返回；
/// 控制面板盖在画面上，不改画面大小；切到后台放掉租约，回来自动连回去。
/// 连到哪了、结束没有、能不能操作，都在 DesktopSession 里；结束了的会话回到前台也不会再连。
final class RemoteDesktopViewController: UIViewController {
    /// 打开时才允许横屏，见 AppDelegate。
    static var isOpen = false

    private static let modeKey = "pupu.desktop.mode"
    private static let qualityKey = "pupu.desktop.quality"

    private let computer: Computer
    private let session: DesktopSession
    private let stage = DesktopStageView()
    private let video = RTCMTLVideoView()
    private let still = UIImageView()
    private let badge = UILabel()
    private let backButton = UIButton.island(image: "chevron.left")
    private let tools = UIStackView()
    private let keyboard = DesktopKeyboardField()
    private var track: RTCVideoTrack?
    private var latency: Int?
    private var observers: [NSObjectProtocol] = []

    init(computer: Computer, endpoint: Endpoint) {
        self.computer = computer
        let saved = UserDefaults.standard.string(forKey: Self.qualityKey).flatMap(DesktopQuality.init(rawValue:))
        session = DesktopSession(endpoint: endpoint, computerId: computer.id, quality: saved ?? .auto)
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .allButUpsideDown }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        stage.frame = view.bounds
        stage.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        stage.mode = UserDefaults.standard.string(forKey: Self.modeKey).flatMap(DesktopInputMode.init(rawValue:)) ?? .touch
        stage.onInput = { [weak self] event in self?.session.input(event) }
        view.addSubview(stage)

        video.videoContentMode = .scaleToFill
        video.delegate = self
        video.isHidden = true
        still.contentMode = .scaleToFill
        still.isHidden = true
        stage.content.addSubview(still)
        stage.content.addSubview(video)

        keyboard.onInput = { [weak self] event in self?.session.input(event) }
        keyboard.onClose = { [weak self] in self?.toggleKeyboard() }
        view.addSubview(keyboard)

        setupChrome()
        bindSession()

        observers.append(NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.session.pause() }
        })
        observers.append(NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.session.start() }
        })
        observers.append(NotificationCenter.default.addObserver(
            forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main
        ) { [weak self] note in
            let end = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect) ?? .zero
            MainActor.assumeIsolated { self?.keyboardMoved(end) }
        })
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        UIApplication.shared.isIdleTimerDisabled = true
        Self.isOpen = true
        setNeedsUpdateOfSupportedInterfaceOrientations()
        session.start()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        UIApplication.shared.isIdleTimerDisabled = false
        Self.isOpen = false
        view.window?.windowScene?.requestGeometryUpdate(.iOS(interfaceOrientations: .portrait))
    }

    /// 不管从哪条路离开（返回、断开、换了身份被收起），页面没了会话就结束。
    isolated deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        session.end()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        layoutChrome()
    }

    // MARK: 界面

    private func setupChrome() {
        backButton.configuration?.contentInsets = .zero
        backButton.accessibilityLabel = "返回"
        backButton.addAction(UIAction { [weak self] _ in self?.close() }, for: .touchUpInside)
        view.addSubview(backButton)

        badge.font = Theme.font(.footnote)
        badge.textColor = Theme.onIsland
        badge.backgroundColor = Theme.islandFill
        badge.textAlignment = .center
        badge.layer.cornerRadius = 14
        badge.layer.masksToBounds = true
        badge.isHidden = true
        view.addSubview(badge)

        tools.spacing = Theme.Space.s3
        tools.distribution = .equalSpacing
        tools.alignment = .center
        for (symbol, name, action) in [
            ("rectangle.3.group", "所有窗口", #selector(allWindows)),
            ("menubar.dock.rectangle", "桌面", #selector(showDesktop)),
            ("keyboard", "键盘", #selector(toggleKeyboard)),
            ("slider.horizontal.3", "控制", #selector(openControls))
        ] {
            let button = UIButton.island(image: symbol)
            button.accessibilityLabel = name
            button.addTarget(self, action: action, for: .touchUpInside)
            NSLayoutConstraint.activate([
                button.widthAnchor.constraint(equalToConstant: Theme.Size.control + 8),
                button.heightAnchor.constraint(equalToConstant: Theme.Size.control)
            ])
            tools.addArrangedSubview(button)
        }
        view.addSubview(tools)
    }

    private func layoutChrome() {
        let safe = view.safeAreaInsets
        let landscape = view.bounds.width > view.bounds.height
        let size = Theme.Size.control
        // 横屏不放返回，控制面板里有断开。返回是 36 的圆，顶边贴着安全区；胶囊和它在同一行居中。
        backButton.isHidden = landscape
        let back = Theme.Size.controlSmall
        let top = max(safe.top, Theme.Space.s3)
        backButton.frame = CGRect(x: safe.left + Theme.Space.s3, y: top, width: back, height: back)
        badge.sizeToFit()
        let badgeWidth = badge.bounds.width + Theme.Space.s6
        badge.frame = CGRect(x: (view.bounds.width - badgeWidth) / 2, y: top + (back - 28) / 2, width: badgeWidth, height: 28)
        if landscape {
            tools.axis = .vertical
            let height = size * 4 + Theme.Space.s3 * 3
            tools.frame = CGRect(
                x: view.bounds.width - safe.right - size - 8 - Theme.Space.s2,
                y: (view.bounds.height - height) / 2,
                width: size + 8,
                height: height
            )
            stage.bottomInset = 0
        } else if keyboard.isFirstResponder {
            tools.isHidden = true
            return
        } else {
            tools.axis = .horizontal
            let width = min(view.bounds.width - Theme.Space.s8, 340)
            tools.frame = CGRect(
                x: (view.bounds.width - width) / 2,
                y: view.bounds.height - safe.bottom - size - Theme.Space.s2,
                width: width,
                height: size
            )
            stage.bottomInset = size + safe.bottom + Theme.Space.s4
        }
        tools.isHidden = false
    }

    private func keyboardMoved(_ end: CGRect) {
        let overlap = max(0, view.bounds.maxY - view.convert(end, from: nil).minY)
        if overlap > 0 { stage.bottomInset = overlap }
        view.setNeedsLayout()
    }

    private func setBadge(_ text: String?) {
        badge.text = text
        badge.isHidden = text == nil
        view.setNeedsLayout()
    }

    // MARK: 会话

    private func bindSession() {
        session.onState = { [weak self] state in self?.render(state) }
        session.onTrack = { [weak self] incoming in
            guard let self else { return }
            self.track?.remove(self.video)
            self.track = incoming
            incoming.add(self.video)
        }
        session.onImage = { [weak self] image in
            guard let self else { return }
            self.still.image = image
            self.still.isHidden = false
            self.video.isHidden = true
            self.stage.desktopSize = image.size
        }
        session.onBusy = { [weak self] by in self?.confirmTakeover(by) }
        session.onControl = { [weak self] control in self?.apply(control) }
        session.onLatency = { [weak self] value in self?.latency = value }
        session.onEnded = { [weak self] message in self?.ended(message) }
        render(session.state)
        apply(session.control)
    }

    private func apply(_ control: DesktopSession.Control) {
        stage.control = control == .on
        if case .refused(let reason?) = control { setBadge(reason) }
    }

    private func render(_ state: DesktopSession.State) {
        switch state {
        case .connecting: setBadge("正在连接「\(computer.name)」…")
        case .live: setBadge(nil)
        case .compatible: setBadge("兼容模式：视频连不上，画面会慢一些")
        case .recovering: setBadge("连接断了，正在恢复…")
        }
    }

    private func confirmTakeover(_ by: String) {
        let alert = UIAlertController(title: "\(by)正在看这台电脑", message: "接管以后对方会断开。", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "取消", style: .cancel) { [weak self] _ in self?.close() })
        alert.addAction(UIAlertAction(title: "接管", style: .default) { [weak self] _ in
            self?.session.takeOver()
        })
        present(alert, animated: true)
    }

    /// 电脑或云端结束了。会话已经停在结束，切到后台再回来也不会在弹窗背后连回去。
    private func ended(_ message: String) {
        let alert = UIAlertController(title: "远程桌面断开了", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "好", style: .default) { [weak self] _ in self?.close() })
        presentedViewController?.dismiss(animated: false)
        present(alert, animated: true)
    }

    private func close() {
        session.end()
        track?.remove(video)
        dismiss(animated: true)
    }

    // MARK: 工具

    @objc private func allWindows() {
        session.input(["t": "key", "k": "ArrowUp", "m": ["ctrl"]])
    }

    @objc private func showDesktop() {
        session.input(["t": "key", "k": "F11"])
    }

    @objc private func toggleKeyboard() {
        if keyboard.isFirstResponder {
            _ = keyboard.resignFirstResponder()
        } else {
            _ = keyboard.becomeFirstResponder()
        }
        view.setNeedsLayout()
    }

    @objc private func openControls() {
        let controls = DesktopControlsViewController(
            mode: stage.mode,
            quality: session.quality,
            viewOnly: session.control == .viewOnly,
            latency: latency
        )
        controls.onMode = { [weak self] mode in
            self?.stage.mode = mode
            UserDefaults.standard.set(mode.rawValue, forKey: Self.modeKey)
        }
        controls.onQuality = { [weak self] quality in
            self?.session.setQuality(quality)
            UserDefaults.standard.set(quality.rawValue, forKey: Self.qualityKey)
        }
        controls.onViewOnly = { [weak self] on in self?.session.setViewOnly(on) }
        controls.onReset = { [weak self] in self?.stage.resetView() }
        controls.onRightClick = { [weak self] in self?.stage.rightClick() }
        controls.onDisconnect = { [weak self] in
            self?.dismiss(animated: false) { self?.close() }
        }
        present(controls, animated: true)
    }

    /// 打开之前过一次 Face ID。这台设备没设密码时不拦。
    /// 设置里「远程控制前」那一档说了算（2026-11-14 定，默认不用确认）：不用确认直接开；
    /// 每台设备确认一次，这台手机按过一次面容就记在云端，之后直接开；每次都确认，每次按面容。
    static func open(_ computer: Computer, endpoint: Endpoint, from host: UIViewController) {
        let level = computer.currentRemoteConfirm
        let present = { host.present(RemoteDesktopViewController(computer: computer, endpoint: endpoint), animated: true) }
        if level == .none || (level == .device && computer.remoteTrusted == true) {
            present()
            return
        }
        Task {
            guard await confirmOwner(computer) else { return }
            if level == .device { try? await Store.shared.api?.trustRemote(computer: computer.id) }
            present()
        }
    }

    private static func confirmOwner(_ computer: Computer) async -> Bool {
        #if targetEnvironment(simulator)
        // 模拟器上验证不了，当作按过了。
        return true
        #else
        let context = LAContext()
        var problem: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &problem) else { return true }
        return (try? await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "打开「\(computer.name)」的远程桌面")) ?? false
        #endif
    }
}

extension RemoteDesktopViewController: RTCVideoViewDelegate {
    nonisolated func videoView(_ videoView: any RTCVideoRenderer, didChangeVideoSize size: CGSize) {
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                guard let self, size.width > 0 else { return }
                self.stage.desktopSize = size
                self.video.isHidden = false
                self.still.isHidden = true
            }
        }
    }
}

/// 文字和快捷键。用系统键盘，拼音选完字才发；上面一条是修饰键和常用键。
final class DesktopKeyboardField: UITextView, UITextViewDelegate {
    var onInput: (([String: Any]) -> Void)?
    var onClose: (() -> Void)?
    private var modifiers = Set<String>()
    private var buttons: [String: UIButton] = [:]

    init() {
        super.init(frame: CGRect(x: -10, y: -10, width: 1, height: 1), textContainer: nil)
        delegate = self
        autocorrectionType = .no
        autocapitalizationType = .none
        spellCheckingType = .no
        smartQuotesType = .no
        smartDashesType = .no
        alpha = 0.01
        inputAccessoryView = strip()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    /// 键盘上面那一条（规范 RemoteDesktop）：`surface-sheet` 底，键是 `surface-inset` 胶囊。
    private func strip() -> UIView {
        let bar = UIScrollView(frame: CGRect(x: 0, y: 0, width: 320, height: 44))
        bar.backgroundColor = Theme.surfaceSheet
        bar.showsHorizontalScrollIndicator = false
        let row = UIStackView()
        row.spacing = Theme.Space.s1
        row.translatesAutoresizingMaskIntoConstraints = false
        bar.addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: bar.contentLayoutGuide.leadingAnchor, constant: Theme.Space.s2),
            row.trailingAnchor.constraint(equalTo: bar.contentLayoutGuide.trailingAnchor, constant: -Theme.Space.s2),
            row.centerYAnchor.constraint(equalTo: bar.centerYAnchor)
        ])
        // 竖屏键盘弹出时工具条藏起来了，收键盘只能在这里按。
        let close = keyButton("") { [weak self] in self?.onClose?() }
        close.configuration?.title = nil
        close.configuration?.image = UIImage(systemName: "keyboard.chevron.compact.down")
        close.accessibilityLabel = "收起键盘"
        row.addArrangedSubview(close)
        for (label, modifier) in [("⌘", "cmd"), ("⌃", "ctrl"), ("⌥", "alt"), ("⇧", "shift")] {
            let button = keyButton(label) { [weak self] in self?.toggle(modifier) }
            buttons[modifier] = button
            row.addArrangedSubview(button)
        }
        for (label, key) in [
            ("esc", "Escape"), ("⇥", "Tab"), ("←", "ArrowLeft"), ("↓", "ArrowDown"), ("↑", "ArrowUp"), ("→", "ArrowRight"),
            ("⌫", "Backspace"), ("⏎", "Enter")
        ] {
            row.addArrangedSubview(keyButton(label) { [weak self] in self?.press(key) })
        }
        return bar
    }

    /// 一个键：`surface-inset` 胶囊、`ink` 字；修饰键按住时（`isSelected`）换 `action` 底、`on-action` 字。
    private func keyButton(_ title: String, _ action: @escaping () -> Void) -> UIButton {
        var configuration = UIButton.Configuration.filled()
        configuration.title = title
        configuration.cornerStyle = .capsule
        configuration.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12)
        configuration.paint(fill: Theme.surfaceInset, ink: Theme.ink)
        let button = UIButton(configuration: configuration, primaryAction: UIAction { _ in action() })
        button.configurationUpdateHandler = { button in
            let held = button.isSelected
            button.configuration?.paint(fill: held ? Theme.action : Theme.surfaceInset, ink: held ? Theme.onAction : Theme.ink, pressed: button.isHighlighted)
        }
        return button
    }

    private func toggle(_ modifier: String) {
        if modifiers.remove(modifier) == nil { modifiers.insert(modifier) }
        buttons[modifier]?.isSelected = modifiers.contains(modifier)
    }

    private func press(_ key: String) {
        onInput?(["t": "key", "k": key, "m": Array(modifiers)])
        clearModifiers()
    }

    private func clearModifiers() {
        for modifier in modifiers { toggle(modifier) }
    }

    func textViewDidChange(_ textView: UITextView) {
        // 拼音还在选字时不发。
        guard markedTextRange == nil, let value = text, !value.isEmpty else { return }
        text = ""
        if !modifiers.isEmpty, value.count == 1 {
            press(value.lowercased())
            return
        }
        if value == "\n" {
            press("Enter")
            return
        }
        onInput?(["t": "text", "s": value])
    }

    override func deleteBackward() {
        if text.isEmpty {
            press("Backspace")
        } else {
            super.deleteBackward()
        }
    }
}

/// 控制面板：盖在画面上，不改画面大小。
final class DesktopControlsViewController: UIViewController {
    var onMode: ((DesktopInputMode) -> Void)?
    var onQuality: ((DesktopQuality) -> Void)?
    var onViewOnly: ((Bool) -> Void)?
    var onReset: (() -> Void)?
    var onRightClick: (() -> Void)?
    var onDisconnect: (() -> Void)?

    private let mode: DesktopInputMode
    private let quality: DesktopQuality
    private let viewOnly: Bool
    private let latency: Int?

    init(mode: DesktopInputMode, quality: DesktopQuality, viewOnly: Bool, latency: Int?) {
        self.mode = mode
        self.quality = quality
        self.viewOnly = viewOnly
        self.latency = latency
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .pageSheet
        sheetPresentationController?.detents = [.medium(), .large()]
        sheetPresentationController?.prefersGrabberVisible = true
        sheetPresentationController?.preferredCornerRadius = Theme.Radius.sheetTop
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.surfaceSheet
        let stack = UIStackView()
        stack.axis = .vertical
        stack.spacing = Theme.Space.s4
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: Theme.Space.s6),
            stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: Theme.Space.s5),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -Theme.Space.s5)
        ])

        let modes = DesktopInputMode.allCases
        let modePicker = UISegmentedControl(items: modes.map(\.title))
        modePicker.selectedSegmentIndex = modes.firstIndex(of: mode) ?? 0
        modePicker.addAction(UIAction { [weak self] action in
            guard let control = action.sender as? UISegmentedControl else { return }
            self?.onMode?(modes[control.selectedSegmentIndex])
        }, for: .valueChanged)
        stack.addArrangedSubview(row("操作方式", modePicker))

        let levels = DesktopQuality.allCases
        let qualityPicker = UISegmentedControl(items: levels.map(\.title))
        qualityPicker.selectedSegmentIndex = levels.firstIndex(of: quality) ?? 0
        qualityPicker.addAction(UIAction { [weak self] action in
            guard let control = action.sender as? UISegmentedControl else { return }
            self?.onQuality?(levels[control.selectedSegmentIndex])
        }, for: .valueChanged)
        stack.addArrangedSubview(row("画质", qualityPicker))

        let toggle = SwitchView()
        toggle.isOn = viewOnly
        toggle.addAction(UIAction { [weak self] action in
            guard let control = action.sender as? UISwitch else { return }
            self?.onViewOnly?(control.isOn)
        }, for: .valueChanged)
        stack.addArrangedSubview(row("只看，不操作", toggle))

        if let latency {
            let label = UILabel()
            label.font = .preferredFont(forTextStyle: .body)
            label.textColor = Theme.inkMuted
            label.text = "\(latency) ms"
            stack.addArrangedSubview(row("网络往返", label))
        }

        // 规范 RemoteDesktop：「点右键」「画面复原」surface-inset 底、ink 字，「断开」surface-inset 底、danger-ink 字。
        for (title, ink, action) in [
            ("点右键", Theme.ink, { [weak self] in self?.dismiss(animated: true) { self?.onRightClick?() } }),
            ("画面复原", Theme.ink, { [weak self] in self?.dismiss(animated: true) { self?.onReset?() } }),
            ("断开", Theme.dangerInk, { [weak self] in self?.onDisconnect?() })
        ] as [(String, UIColor, () -> Void)] {
            var config = UIButton.Configuration.gray()
            config.title = title
            config.cornerStyle = .capsule
            config.paint(fill: Theme.surfaceInset, ink: ink)
            let button = UIButton(configuration: config, primaryAction: UIAction { _ in action() })
            button.configurationUpdateHandler = { button in
                button.configuration?.paint(fill: Theme.surfaceInset, ink: ink, pressed: button.isHighlighted)
            }
            button.heightAnchor.constraint(equalToConstant: Theme.Size.control).isActive = true
            stack.addArrangedSubview(button)
        }
    }

    private func row(_ title: String, _ control: UIView) -> UIView {
        let label = UILabel()
        label.text = title
        label.font = .preferredFont(forTextStyle: .body)
        label.textColor = Theme.ink
        let row = UIStackView(arrangedSubviews: [label, control])
        row.alignment = .center
        row.distribution = .equalSpacing
        return row
    }
}
