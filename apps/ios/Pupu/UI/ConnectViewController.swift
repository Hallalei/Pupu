import UIKit

/// 第一次打开，或者凭据失效了：填 Pupu 的地址，用自己的 Google 账号登录（要在成员名单上），换这台手机自己的凭据。
/// 也能填配对码；手边一台连上的设备都没有时，改用访问口令。
final class ConnectViewController: UIViewController, UITextFieldDelegate {
    private enum Mode {
        case google, code, token
    }

    /// 这一页在干什么。请求在路上时不能换方式，按钮跟着状态走；离开这一页时取消。
    private enum Flow {
        case editing
        /// 在登录或者配对，按钮转圈。
        case connecting(Task<Void, Never>)
        /// 新手机在等已有手机点允许，按钮是「取消」。
        case waiting(Task<Void, Never>, expiresAt: Double)

        var task: Task<Void, Never>? {
            switch self {
            case .editing: nil
            case .connecting(let task), .waiting(let task, _): task
            }
        }
    }

    private let server = UITextField()
    private let secret = UITextField()
    private lazy var secretRow = field(secret)
    private let note = UILabel(style: .message, color: Theme.inkSky, lines: 0)
    private let status = UILabel(style: .subheadline, color: Theme.inkMuted, lines: 0)
    private let connect = UIButton.action(title: "连接")
    private let mode = UIButton(configuration: .plain())
    /// 填码的时候，回到 Google 登录。
    private let back = UIButton(configuration: .plain())
    private var current: Mode = .google
    private var flow: Flow = .editing {
        didSet { render() }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear

        let title = UILabel(text: "连接 Pupu", style: .greeting, color: Theme.inkSky)

        configure(server, placeholder: "地址，比如 https://pupu.example.workers.dev")
        server.text = (Connection.shared.lastServer?.absoluteString) ?? Connection.suggestedServer
        server.keyboardType = .URL
        server.textContentType = .URL
        server.autocapitalizationType = .none
        server.returnKeyType = .next
        configure(secret, placeholder: "")
        secret.returnKeyType = .go
        showMode()
        render()

        let fields = UIStackView(arrangedSubviews: [field(server), secretRow])
        fields.axis = .vertical
        fields.spacing = Theme.Space.s3

        connect.addAction(UIAction { [weak self] _ in self?.primary() }, for: .primaryActionTriggered)
        for link in [mode, back] {
            link.configuration?.baseForegroundColor = Theme.inkSky
            link.configuration?.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
                var attributes = attributes
                attributes.font = Theme.font(.subheadline)
                return attributes
            }
        }
        mode.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            switch current {
            case .google, .token: switchMode(to: .code)
            case .code: switchMode(to: .token)
            }
        }, for: .primaryActionTriggered)
        back.configuration?.title = "用 Google 登录"
        back.addAction(UIAction { [weak self] _ in self?.switchMode(to: .google) }, for: .primaryActionTriggered)

        let stack = UIStackView(arrangedSubviews: [title, note, fields, connect, mode, back, status])
        stack.axis = .vertical
        stack.spacing = Theme.Space.s4
        stack.setCustomSpacing(Theme.Space.s2, after: title)
        stack.setCustomSpacing(Theme.Space.s6, after: note)
        stack.setCustomSpacing(Theme.Space.s2, after: connect)
        stack.setCustomSpacing(0, after: mode)
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
            stack.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor, constant: -40),
            connect.heightAnchor.constraint(greaterThanOrEqualToConstant: 50)
        ])
        view.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 0, leading: Theme.Space.s4, bottom: 0, trailing: Theme.Space.s4)

        if let notice = Connection.shared.notice {
            show(notice, error: true)
            Connection.shared.notice = nil
        }
    }

    /// 离开这一页（比如配对链接先连上了）：还在登录或配对的那一路取消，回来的凭据不再用。
    override func willMove(toParent parent: UIViewController?) {
        super.willMove(toParent: parent)
        if parent == nil { flow.task?.cancel() }
    }

    private func switchMode(to next: Mode) {
        guard case .editing = flow else { return }
        current = next
        showMode()
        render()
        show("", error: false)
    }

    /// 用 Google 登录，还是第二个框填配对码或访问口令。
    private func showMode() {
        secret.text = nil
        secretRow.isHidden = current == .google
        server.returnKeyType = current == .google ? .go : .next
        switch current {
        case .google:
            note.text = "填 Pupu 的地址，用你的 Google 账号登录。这个 Pupu 连过手机的话，要在一台已经连上的手机上点「允许」。"
            mode.configuration?.title = "用配对码或访问口令"
        case .code:
            note.text = "填 Pupu 的地址和配对码。配对码在已经连上的手机上生成：设置 → 连接新设备。也可以用相机扫二维码。"
            secret.placeholder = "配对码，比如 7K3M-Q9TX"
            secret.isSecureTextEntry = false
            secret.textContentType = .oneTimeCode
            secret.keyboardType = .asciiCapable
            secret.autocapitalizationType = .allCharacters
            mode.configuration?.title = "手边没有连上的设备？用访问口令"
        case .token:
            note.text = "访问口令只用这一次，换成这台手机自己的凭据。"
            secret.placeholder = "访问口令"
            secret.isSecureTextEntry = true
            secret.textContentType = .password
            secret.keyboardType = .default
            secret.autocapitalizationType = .none
            mode.configuration?.title = "用配对码"
        }
        if secret.isFirstResponder { secret.reloadInputViews() }
    }

    /// 按钮和换方式的链接只看 flow。
    private func render() {
        let editing: Bool
        switch flow {
        case .editing:
            editing = true
            connect.configuration?.title = current == .google ? "用 Google 登录" : "连接"
            connect.configuration?.showsActivityIndicator = false
            connect.isEnabled = true
        case .connecting:
            editing = false
            connect.configuration?.showsActivityIndicator = true
            connect.isEnabled = false
        case .waiting(_, let expiresAt):
            editing = false
            let minutes = max(1, Int(((expiresAt - Date.now.timeIntervalSince1970 * 1000) / 60_000).rounded(.up)))
            show("在已经连上的手机上点「允许」：锁屏上会有一条通知，打开 App 顶上也能看到。\(minutes) 分钟内没点就作废。", error: false)
            connect.configuration?.title = "取消"
            connect.configuration?.showsActivityIndicator = false
            connect.isEnabled = true
        }
        mode.isHidden = !editing
        back.isHidden = !editing || current == .google
        server.isEnabled = editing
        secret.isEnabled = editing
    }

    private func configure(_ field: UITextField, placeholder: String) {
        field.placeholder = placeholder
        field.font = Theme.font(.body)
        field.adjustsFontForContentSizeCategory = true
        field.textColor = Theme.ink
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.clearButtonMode = .whileEditing
        field.delegate = self
    }

    private func field(_ field: UITextField) -> UIView {
        let surface = SurfaceView(.strong, radius: Theme.Radius.row)
        surface.contentView.addSubview(field)
        field.pin(to: surface.contentView, insets: UIEdgeInsets(top: 14, left: Theme.Space.s4, bottom: 14, right: Theme.Space.s3))
        return surface
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        if textField === server, current != .google {
            secret.becomeFirstResponder()
        } else {
            primary()
        }
        return true
    }

    private func primary() {
        switch flow {
        case .editing:
            guard let base = Connection.normalize(server.text ?? "") else {
                show("地址不对。填 https:// 开头的地址，比如 https://pupu.example.workers.dev。", error: true)
                return
            }
            view.endEditing(true)
            flow = .connecting(current == .google ? signIn(base) : pair(base))
        case .connecting:
            break
        case .waiting(let task, _):
            task.cancel()
            flow = .editing
            show("", error: false)
        }
    }

    private func signIn(_ base: URL) -> Task<Void, Never> {
        show("", error: false)
        let signIn = SignIn(anchor: view.window)
        return Task {
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
                finished(error)
            }
        }
    }

    private func pair(_ base: URL) -> Task<Void, Never> {
        let text = secret.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let accessToken = current == .token && !text.isEmpty ? text : nil
        // 什么都不填，只有连本机的开发服务器时能过；线上会回「要填配对码」。
        let code = current == .token || text.isEmpty ? nil : text
        show("正在连接…", error: false)
        return Task {
            do {
                let paired = try await API.pair(base: base, code: code, accessToken: accessToken, name: UIDevice.current.name)
                try Task.checkCancellation()
                Connection.shared.adopt(base: base, paired: paired)
            } catch {
                finished(error)
            }
        }
    }

    /// 没连上。取消了就什么都不说：取消的那一方已经把页面摆回去了，或者这一页已经不在了。
    private func finished(_ error: any Error) {
        guard !Task.isCancelled else { return }
        flow = .editing
        if error is CancellationError {
            show("", error: false)
        } else {
            show("没连上：\(error.localizedDescription)", error: true)
        }
    }

    private func show(_ text: String, error: Bool) {
        status.text = text
        status.textColor = error ? Theme.dangerInk : Theme.inkSky
    }
}
