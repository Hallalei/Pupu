import UIKit

/// 第一次打开，或者凭据失效了：填 Pupu 的地址，用自己的 Google 账号登录（要在成员名单上），换这台手机自己的凭据。
/// 也能填配对码；手边一台连上的设备都没有时，改用访问口令。
final class ConnectViewController: UIViewController, UITextFieldDelegate {
    private enum Mode {
        case google, code, token
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
    private var signIn: SignIn?
    private var signInTask: Task<Void, Never>?

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
            case .google, .token: current = .code
            case .code: current = .token
            }
            showMode()
            show("", error: false)
        }, for: .primaryActionTriggered)
        back.configuration?.title = "用 Google 登录"
        back.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            current = .google
            showMode()
            show("", error: false)
        }, for: .primaryActionTriggered)

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

    /// 用 Google 登录，还是第二个框填配对码或访问口令。
    private func showMode() {
        secret.text = nil
        secretRow.isHidden = current == .google
        back.isHidden = current == .google
        mode.isHidden = false
        server.returnKeyType = current == .google ? .go : .next
        switch current {
        case .google:
            note.text = "填 Pupu 的地址，用你的 Google 账号登录。这个 Pupu 连过手机的话，要在一台已经连上的手机上点「允许」。"
            connect.configuration?.title = "用 Google 登录"
            mode.configuration?.title = "用配对码或访问口令"
        case .code:
            note.text = "填 Pupu 的地址和配对码。配对码在已经连上的手机上生成：设置 → 连接新设备。也可以用相机扫二维码。"
            secret.placeholder = "配对码，比如 7K3M-Q9TX"
            secret.isSecureTextEntry = false
            secret.textContentType = .oneTimeCode
            secret.keyboardType = .asciiCapable
            secret.autocapitalizationType = .allCharacters
            connect.configuration?.title = "连接"
            mode.configuration?.title = "手边没有连上的设备？用访问口令"
        case .token:
            note.text = "访问口令只用这一次，换成这台手机自己的凭据。"
            secret.placeholder = "访问口令"
            secret.isSecureTextEntry = true
            secret.textContentType = .password
            secret.keyboardType = .default
            secret.autocapitalizationType = .none
            connect.configuration?.title = "连接"
            mode.configuration?.title = "用配对码"
        }
        if secret.isFirstResponder { secret.reloadInputViews() }
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
        // 正在等已有手机点允许：这个按钮是「取消」。
        if let signInTask {
            signInTask.cancel()
            signIn?.cancel()
            return
        }
        if current == .google { tryGoogle() } else { tryConnect() }
    }

    private func tryGoogle() {
        guard let base = Connection.normalize(server.text ?? "") else {
            show("地址不对。填 https:// 开头的地址，比如 https://pupu.example.workers.dev。", error: true)
            return
        }
        view.endEditing(true)
        connect.configuration?.showsActivityIndicator = true
        connect.isEnabled = false
        show("", error: false)
        let signIn = SignIn(anchor: view.window)
        self.signIn = signIn
        signInTask = Task {
            defer {
                self.signIn = nil
                signInTask = nil
                connect.configuration?.showsActivityIndicator = false
                connect.isEnabled = true
                showMode()
            }
            do {
                let paired = try await signIn.run(base: base) { [weak self] progress in
                    guard let self else { return }
                    switch progress {
                    case .waiting(let expiresAt): showWaiting(until: expiresAt)
                    }
                }
                await Connection.shared.adopt(base: base, paired: paired)
            } catch is CancellationError {
                show("", error: false)
            } catch {
                show("没连上：\(error.localizedDescription)", error: true)
            }
        }
    }

    /// 新手机在等已有手机点允许。按钮换成「取消」。
    private func showWaiting(until expiresAt: Double) {
        let minutes = max(1, Int(((expiresAt - Date.now.timeIntervalSince1970 * 1000) / 60_000).rounded(.up)))
        show("在已经连上的手机上点「允许」：锁屏上会有一条通知，打开 App 顶上也能看到。\(minutes) 分钟内没点就作废。", error: false)
        connect.configuration?.showsActivityIndicator = false
        connect.configuration?.title = "取消"
        connect.isEnabled = true
        mode.isHidden = true
    }

    private func tryConnect() {
        guard let base = Connection.normalize(server.text ?? "") else {
            show("地址不对。填 https:// 开头的地址，比如 https://pupu.example.workers.dev。", error: true)
            return
        }
        let text = secret.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        view.endEditing(true)
        connect.configuration?.showsActivityIndicator = true
        connect.isEnabled = false
        show("正在连接…", error: false)
        Task {
            defer {
                connect.configuration?.showsActivityIndicator = false
                connect.isEnabled = true
            }
            do {
                // 什么都不填，只有连本机的开发服务器时能过；线上会回「要填配对码」。
                try await Connection.shared.pair(
                    base: base,
                    code: current == .token || text.isEmpty ? nil : text,
                    accessToken: current == .token && !text.isEmpty ? text : nil
                )
            } catch {
                show("没连上：\(error.localizedDescription)", error: true)
            }
        }
    }

    private func show(_ text: String, error: Bool) {
        status.text = text
        status.textColor = error ? Theme.dangerInk : Theme.inkSky
    }
}
