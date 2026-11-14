import UIKit

/// 登录页（规范 SignIn）：还没连上 Pupu 时整屏就是它，第一次打开或者被吊销以后。天空由 RootViewController 铺在下面，
/// 天空上只写「Pupu」和一句话；按钮、输入框和出错的字都在贴着屏幕底的实色卡片上，卡片底跟着键盘走。
/// 默认是「用 Google 登录」、一条「或」、配对码和「继续」；手边没有连上的设备时换成访问口令。
/// 卡片最下面写着连的主机，点它在卡片最上面展开地址框，自部署的在这里改。
final class ConnectViewController: UIViewController, UITextFieldDelegate {
    /// 这一页在干什么。请求在路上时不能换方式，按钮跟着状态走；离开这一页时取消。
    private enum Flow {
        case editing
        /// 在系统的登录页里选 Google 账号：Google 按钮的 G 换成转圈。
        case google(Task<Void, Never>)
        /// 拿配对码或访问口令在配：「继续」转圈。
        case pairing(Task<Void, Never>)
        /// 新手机在等已有手机点允许：卡片里只有那两句和「取消」。
        case waiting(Task<Void, Never>, expiresAt: Double)

        var task: Task<Void, Never>? {
            switch self {
            case .editing: nil
            case .google(let task), .pairing(let task), .waiting(let task, _): task
            }
        }
    }

    private let card = CardView(topRadius: Theme.Radius.sheetTop)
    private let scroll = UIScrollView()
    private let form = UIStackView()
    private let notice = UILabel(style: .subheadline, color: Theme.inkMuted, lines: 0)
    private let server = FieldView()
    private let google = UIButton(configuration: .filled())
    private let or = OrDivider()
    private let secret = FieldView()
    private let proceed = UIButton.action(title: "继续")
    private let failure = UILabel(style: .subheadline, color: Theme.dangerInk, lines: 0)
    private let switchKind = UIButton(configuration: .plain())
    private let host = UIButton(configuration: .plain())
    private let waitTitle = UILabel(text: "在已经连上的手机上点「允许」", style: .headline, lines: 0)
    private let waitNote = UILabel(style: .subheadline, color: Theme.inkMuted, lines: 0)
    private let cancel = UIButton.secondary(title: "取消")
    private var useToken = false
    /// 这个 Pupu 有没有配 Google 登录。问不到时照样显示：线上一直开着，真没开的话，点了云端会说明。
    private var googleEnabled = true
    private var checkedServer: URL?
    private var ticker: Timer?
    private var flow: Flow = .editing {
        didSet { render() }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear

        // 天空上只放这两行：844 高的屏幕上从 274 起。卡片长高或键盘弹起时盖住就盖住，不往上挤。
        let name = UILabel(text: "Pupu", style: .greeting, color: Theme.inkSky)
        let line = UILabel(text: "组织大脑，让智能在组织间流动。", style: .message, color: Theme.inkSky, lines: 0)
        name.textAlignment = .center
        line.textAlignment = .center
        let brand = UIStackView(arrangedSubviews: [name, line])
        brand.axis = .vertical
        brand.spacing = Theme.Space.s2
        brand.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(brand)
        let above = UILayoutGuide()
        view.addLayoutGuide(above)

        configureFields()
        configureButtons()

        notice.textAlignment = .center
        failure.textAlignment = .center
        waitTitle.textAlignment = .center
        waitNote.textAlignment = .center
        [google, proceed, cancel].forEach {
            $0.heightAnchor.constraint(equalToConstant: Theme.Size.control).isActive = true
        }
        for view in [notice, server, google, or, secret, proceed, failure, switchKind, host, waitTitle, waitNote, cancel] {
            form.addArrangedSubview(view)
        }
        form.axis = .vertical
        form.spacing = Theme.Space.s3
        // 主机名紧跟在链接那一行下面（规范预览里隔 8），等待的两句隔 8，和「取消」隔 16。
        form.setCustomSpacing(Theme.Space.s2, after: switchKind)
        form.setCustomSpacing(Theme.Space.s2, after: waitTitle)
        form.setCustomSpacing(Theme.Space.s4, after: waitNote)
        form.isLayoutMarginsRelativeArrangement = true
        // 下面 34 已经让开了 Home 指示条，不再叠加安全区。
        form.insetsLayoutMarginsFromSafeArea = false
        // 内边距上 24、左右 16、下 34（让开 Home 指示条）。
        form.directionalLayoutMargins = NSDirectionalEdgeInsets(top: Theme.Space.s6, leading: Theme.Space.s4, bottom: 34, trailing: Theme.Space.s4)
        form.translatesAutoresizingMaskIntoConstraints = false

        // 字号调大时卡片往上长，放不下整页能滚。
        scroll.keyboardDismissMode = .interactive
        scroll.contentInsetAdjustmentBehavior = .never
        scroll.showsVerticalScrollIndicator = false
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(form)
        card.contentView.addSubview(scroll)
        card.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(card)

        // 没有键盘时导引的上沿就是屏幕底，卡片离屏幕底 6；键盘弹起时贴着键盘。
        view.keyboardLayoutGuide.usesBottomSafeArea = false
        let fit = scroll.heightAnchor.constraint(equalTo: form.heightAnchor)
        fit.priority = .defaultHigh
        NSLayoutConstraint.activate([
            above.topAnchor.constraint(equalTo: view.topAnchor),
            above.heightAnchor.constraint(equalTo: view.heightAnchor, multiplier: 274.0 / 844.0),
            brand.topAnchor.constraint(equalTo: above.bottomAnchor),
            brand.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: Theme.Space.s6),
            brand.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -Theme.Space.s6),

            card.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: Theme.Space.frameGap),
            card.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -Theme.Space.frameGap),
            card.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor, constant: -Theme.Space.frameGap),
            card.topAnchor.constraint(greaterThanOrEqualTo: view.safeAreaLayoutGuide.topAnchor, constant: Theme.Space.s2),
            scroll.topAnchor.constraint(equalTo: card.contentView.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: card.contentView.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: card.contentView.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: card.contentView.trailingAnchor),
            fit,
            form.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            form.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            form.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor),
            form.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor)
        ])

        // 被吊销回到这一页：卡片顶上多一句，下面照常。
        if let text = Connection.shared.notice {
            notice.text = text
            Connection.shared.notice = nil
        }
        showKind()
        render()
        checkGoogle()
    }

    /// 离开这一页（比如配对链接先连上了）：还在登录或配对的那一路取消，回来的凭据不再用。
    override func willMove(toParent parent: UIViewController?) {
        super.willMove(toParent: parent)
        if parent == nil {
            flow.task?.cancel()
            stopTicking()
        }
    }

    // MARK: 搭起来

    private func configureFields() {
        server.placeholder = "地址，比如 https://pupu.example.workers.dev"
        server.accessibilityLabel = "Pupu 的地址"
        server.text = (Connection.shared.lastServer?.absoluteString) ?? Connection.suggestedServer
        server.textAlignment = .center
        server.keyboardType = .URL
        server.textContentType = .URL
        server.autocapitalizationType = .none
        server.autocorrectionType = .no
        server.spellCheckingType = .no
        server.returnKeyType = .next
        server.isHidden = true
        server.delegate = self
        server.addAction(UIAction { [weak self] _ in self?.updateHost() }, for: .editingChanged)
        server.addAction(UIAction { [weak self] _ in self?.checkGoogle() }, for: .editingDidEnd)

        secret.autocorrectionType = .no
        secret.spellCheckingType = .no
        secret.returnKeyType = .go
        secret.delegate = self
        secret.addAction(UIAction { [weak self] _ in self?.edited() }, for: .editingChanged)
    }

    private func configureButtons() {
        // 例外一：Google 按钮照 Google 的品牌规定，不用 token。左边四色 G 18pt，和字隔 12；等的时候 G 换成转圈，字不变。
        var config = UIButton.Configuration.filled()
        config.title = "用 Google 登录"
        config.image = UIImage(named: "google-g")?.withRenderingMode(.alwaysOriginal)
        config.imagePadding = Theme.Space.s3
        config.cornerStyle = .capsule
        config.background.strokeColor = Google.stroke
        config.background.strokeWidth = 1
        google.configuration = config
        google.configurationUpdateHandler = { button in
            let shown = button.isHighlighted ? Google.pressed : Google.fill
            let ink = Google.ink
            button.configuration?.baseBackgroundColor = shown
            button.configuration?.baseForegroundColor = ink
            button.configuration?.background.backgroundColorTransformer = UIConfigurationColorTransformer { _ in shown }
            button.configuration?.activityIndicatorColorTransformer = UIConfigurationColorTransformer { _ in ink }
            button.configuration?.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
                var attributes = attributes
                attributes.font = Theme.font(.body, weight: .medium)
                attributes.foregroundColor = ink
                return attributes
            }
        }
        google.addAction(UIAction { [weak self] _ in self?.startGoogle() }, for: .primaryActionTriggered)

        proceed.addAction(UIAction { [weak self] _ in self?.startPairing() }, for: .primaryActionTriggered)
        cancel.addAction(UIAction { [weak self] _ in self?.stop() }, for: .primaryActionTriggered)

        // 链接那一行比上面多隔 4（规范预览 `.more`）。
        switchKind.configuration?.contentInsets = NSDirectionalEdgeInsets(top: Theme.Space.s1, leading: 0, bottom: 0, trailing: 0)
        switchKind.addAction(UIAction { [weak self] _ in
            guard let self, case .editing = flow else { return }
            useToken.toggle()
            showKind()
            failure.text = nil
            render()
            secret.becomeFirstResponder()
        }, for: .primaryActionTriggered)

        host.configuration?.contentInsets = .zero
        host.accessibilityHint = "改地址"
        host.addAction(UIAction { [weak self] _ in self?.showServer() }, for: .primaryActionTriggered)
        updateHost()
    }

    /// 配对码还是访问口令：框、占位和下面那行链接跟着换。
    private func showKind() {
        secret.text = nil
        let centered = NSMutableParagraphStyle()
        centered.alignment = .center
        if useToken {
            secret.isSecureTextEntry = true
            secret.textContentType = .password
            secret.keyboardType = .default
            secret.autocapitalizationType = .none
            secret.defaultTextAttributes = [.font: Theme.font(.body), .foregroundColor: Theme.ink, .paragraphStyle: centered]
        } else {
            // 填进去的码用等宽字、字距 0.1em，自动转大写。
            secret.isSecureTextEntry = false
            secret.textContentType = .oneTimeCode
            secret.keyboardType = .asciiCapable
            secret.autocapitalizationType = .allCharacters
            let mono = UIFontMetrics(forTextStyle: .body).scaledFont(for: .monospacedSystemFont(ofSize: 17, weight: .regular))
            secret.defaultTextAttributes = [.font: mono, .kern: 1.7, .foregroundColor: Theme.ink, .paragraphStyle: centered]
        }
        let kind = useToken ? "访问口令" : "配对码"
        secret.attributedPlaceholder = NSAttributedString(string: kind, attributes: [
            .font: Theme.font(.body), .foregroundColor: Theme.inkMuted, .paragraphStyle: centered
        ])
        secret.accessibilityLabel = kind

        // 前半句 `ink-muted`，「用访问口令」「用配对码」用 `ink` 加下划线。
        var lead = AttributedString(useToken ? "" : "手边没有连上的设备？")
        lead.font = Theme.font(.subheadline)
        lead.foregroundColor = Theme.inkMuted
        var link = AttributedString(useToken ? "用配对码" : "用访问口令")
        link.font = Theme.font(.subheadline)
        link.foregroundColor = Theme.ink
        link.uiKit.underlineStyle = .single
        switchKind.configuration?.attributedTitle = lead + link
        if secret.isFirstResponder { secret.reloadInputViews() }
    }

    /// 卡片最下面那一行：连的主机名，`footnote`、`ink-muted`。
    private func updateHost() {
        let typed = server.text ?? ""
        let name = Connection.normalize(typed)?.host() ?? typed
        var title = AttributedString(name.isEmpty ? "填 Pupu 的地址" : name)
        title.font = Theme.font(.footnote)
        title.foregroundColor = Theme.inkMuted
        host.configuration?.attributedTitle = title
        host.accessibilityLabel = name.isEmpty ? "填 Pupu 的地址" : "连的 Pupu：\(name)"
    }

    /// 点主机名：在卡片最上面展开地址框。
    private func showServer() {
        if server.isHidden {
            UIView.animate(springDuration: 0.3, bounce: 0) {
                self.server.isHidden = false
                self.view.layoutIfNeeded()
            }
        }
        server.becomeFirstResponder()
    }

    /// 问这个 Pupu 开没开 Google 登录：没开就不出 Google 按钮和「或」。
    private func checkGoogle() {
        guard let base = Connection.normalize(server.text ?? ""), base != checkedServer else { return }
        checkedServer = base
        Task { [weak self] in
            var request = URLRequest(url: base.appending(path: "api/auth/google"))
            request.timeoutInterval = 10
            var enabled = true
            if let (data, response) = try? await URLSession.shared.data(for: request),
               (response as? HTTPURLResponse)?.statusCode == 200,
               let answer = try? JSONDecoder().decode(GoogleSetting.self, from: data) {
                enabled = answer.enabled
            }
            guard let self, checkedServer == base else { return }
            googleEnabled = enabled
            render()
        }
    }

    // MARK: 状态

    /// 卡片里出现什么只看 flow：默认是 Google、或、码和「继续」；等允许时只有那两句和「取消」。
    private func render() {
        var waiting = false
        var signingIn = false
        var pairing = false
        switch flow {
        case .editing:
            stopTicking()
        case .google:
            signingIn = true
        case .pairing:
            pairing = true
        case .waiting(_, let expiresAt):
            waiting = true
            let minutes = max(1, Int(((expiresAt - Date.now.timeIntervalSince1970 * 1000) / 60_000).rounded(.up)))
            waitNote.text = "锁屏上会有一条通知，打开 App 顶上也能看到。\(minutes) 分钟内没点就作废。"
            startTicking()
        }
        let busy = signingIn || pairing || waiting
        let filled = !(secret.text ?? "").trimmingCharacters(in: .whitespaces).isEmpty

        google.configuration?.showsActivityIndicator = signingIn
        google.isUserInteractionEnabled = !busy
        // 没填码时「继续」是 action-off，主次留给 Google；填了才换成 action。在配的时候照样是 action，转圈。
        proceed.isEnabled = filled || pairing
        proceed.isUserInteractionEnabled = !busy
        proceed.configuration?.showsActivityIndicator = pairing
        server.isEnabled = !busy
        secret.isEnabled = !busy
        switchKind.isEnabled = !busy
        host.isEnabled = !busy

        setHidden(notice, notice.text == nil || waiting)
        setHidden(server, server.isHidden || waiting)
        setHidden(google, !googleEnabled || waiting)
        setHidden(or, !googleEnabled || waiting)
        setHidden(secret, waiting)
        setHidden(proceed, waiting)
        setHidden(failure, (failure.text ?? "").isEmpty || waiting)
        setHidden(switchKind, waiting)
        setHidden(host, waiting)
        setHidden(waitTitle, !waiting)
        setHidden(waitNote, !waiting)
        setHidden(cancel, !waiting)
    }

    /// 堆叠视图里的视图只在真的变了时才改 isHidden。
    private func setHidden(_ view: UIView, _ hidden: Bool) {
        if view.isHidden != hidden { view.isHidden = hidden }
    }

    /// 等允许时每 15 秒重算一次还剩几分钟。
    private func startTicking() {
        guard ticker == nil else { return }
        ticker = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.render() }
        }
    }

    private func stopTicking() {
        ticker?.invalidate()
        ticker = nil
    }

    private func edited() {
        if !useToken, let text = secret.text, text != text.uppercased() {
            secret.text = text.uppercased()
        }
        render()
    }

    /// 在码的框里按回车等于「继续」。
    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        if textField === server {
            secret.becomeFirstResponder()
        } else {
            startPairing()
        }
        return true
    }

    // MARK: 连

    /// 填的地址；不对就在「继续」下面说，再把地址框展开。
    private func base() -> URL? {
        if let base = Connection.normalize(server.text ?? "") { return base }
        show("地址不对。填 https:// 开头的地址，比如 https://pupu.example.workers.dev。")
        showServer()
        return nil
    }

    private func startGoogle() {
        guard case .editing = flow, let base = base() else { return }
        view.endEditing(true)
        show(nil)
        let signIn = SignIn(anchor: view.window)
        flow = .google(Task {
            do {
                let paired = try await signIn.run(base: base) { [weak self] progress in
                    guard let self, let task = flow.task else { return }
                    switch progress {
                    case .waiting(let expiresAt): flow = .waiting(task, expiresAt: expiresAt)
                    }
                }
                try Task.checkCancellation()
                Connection.shared.adopt(base: base, paired: paired)
            } catch {
                finished(error, base: base)
            }
        })
    }

    private func startPairing() {
        let text = secret.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        // 模拟器里码的框空着按回车也能配：本机的开发服务器没设访问口令时不要码。
        #if !targetEnvironment(simulator)
        guard !text.isEmpty else { return }
        #endif
        guard case .editing = flow, let base = base() else { return }
        view.endEditing(true)
        show(nil)
        let accessToken = useToken && !text.isEmpty ? text : nil
        let code = useToken || text.isEmpty ? nil : text
        flow = .pairing(Task {
            do {
                let paired = try await API.pair(base: base, code: code, accessToken: accessToken, name: UIDevice.current.name)
                try Task.checkCancellation()
                Connection.shared.adopt(base: base, paired: paired)
            } catch {
                finished(error, base: base)
            }
        })
    }

    /// 等允许时点「取消」：回到默认，不算出错。
    private func stop() {
        flow.task?.cancel()
        flow = .editing
        show(nil)
    }

    /// 没连上：一句话写在「继续」下面，填过的码不清空。取消了就什么都不说：取消的那一方已经把页面摆回去了。
    private func finished(_ error: any Error, base: URL) {
        guard !Task.isCancelled else { return }
        flow = .editing
        if error is CancellationError {
            show(nil)
        } else if error is URLError || (error as? APIError)?.offline == true {
            show("连不上 \(base.host() ?? base.absoluteString)，看看网络。")
        } else {
            show(error.localizedDescription)
        }
    }

    private func show(_ text: String?) {
        failure.text = text
        render()
    }
}

/// `GET /api/auth/google` 的回答：这个 Pupu 有没有配 Google 登录。
private nonisolated struct GoogleSetting: Decodable {
    let enabled: Bool
}

/// Google 品牌规定的按钮颜色（规范 SignIn 例外一）：浅色白底、#747775 描边、#1f1f1f 字；
/// 深色用 Google 的深色样式，#131314 底、#8e918f 描边、#e3e3e3 字，填了码以后和 `action` 分得开。
private enum Google {
    static let fill = dynamic(0xffffff, 0x131314)
    static let pressed = dynamic(0xf2f2f2, 0x26272a)
    static let stroke = dynamic(0x747775, 0x8e918f)
    static let ink = dynamic(0x1f1f1f, 0xe3e3e3)

    private static func dynamic(_ light: UInt32, _ dark: UInt32) -> UIColor {
        let light = rgb(light)
        let dark = rgb(dark)
        return UIColor { $0.userInterfaceStyle == .dark ? dark : light }
    }

    private static func rgb(_ hex: UInt32) -> UIColor {
        UIColor(red: CGFloat(hex >> 16 & 0xff) / 255, green: CGFloat(hex >> 8 & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: 1)
    }
}

/// 「或」：`footnote`、`ink-muted`，两边各一条 1pt `line`，和字隔 12。
private final class OrDivider: UIView {
    override init(frame: CGRect) {
        super.init(frame: frame)
        let label = UILabel(text: "或", style: .footnote, color: Theme.inkMuted)
        label.setContentHuggingPriority(.required, for: .horizontal)
        label.setContentCompressionResistancePriority(.required, for: .horizontal)
        let left = UIView()
        let right = UIView()
        for line in [left, right] {
            line.backgroundColor = Theme.line
            line.heightAnchor.constraint(equalToConstant: 1).isActive = true
        }
        let row = UIStackView(arrangedSubviews: [left, label, right])
        row.spacing = Theme.Space.s3
        row.alignment = .center
        addSubview(row)
        row.pin(to: self)
        left.widthAnchor.constraint(equalTo: right.widthAnchor).isActive = true
        isAccessibilityElement = false
        accessibilityElementsHidden = true
    }

    required init?(coder: NSCoder) { fatalError() }
}
