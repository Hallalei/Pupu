import UIKit

/// 第一次打开，或者凭据失效了：填 Pupu 的地址和配对码，换这台手机自己的凭据。
/// 手边一台连上的设备都没有时，改用访问口令。
final class ConnectViewController: UIViewController, UITextFieldDelegate {
    private let server = UITextField()
    private let secret = UITextField()
    private let status = UILabel(style: .subheadline, color: Theme.inkMuted, lines: 0)
    private let connect = UIButton.action(title: "连接")
    private let mode = UIButton(configuration: .plain())
    private var usesToken = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear

        let title = UILabel(text: "连接 Pupu", style: .greeting, color: Theme.inkSky)
        let note = UILabel(
            text: "填 Pupu 的地址和配对码。配对码在已经连上的网页或手机上生成：设置 → 连接新设备。也可以用相机扫网页上的二维码。",
            style: .message,
            color: Theme.inkSky,
            lines: 0
        )

        configure(server, placeholder: "地址，比如 https://pupu.example.workers.dev")
        server.text = (Connection.shared.lastServer?.absoluteString) ?? Connection.suggestedServer
        server.keyboardType = .URL
        server.textContentType = .URL
        server.autocapitalizationType = .none
        server.returnKeyType = .next
        configure(secret, placeholder: "")
        secret.returnKeyType = .go
        showMode()

        let fields = UIStackView(arrangedSubviews: [field(server), field(secret)])
        fields.axis = .vertical
        fields.spacing = Theme.Space.s3

        connect.addAction(UIAction { [weak self] _ in self?.tryConnect() }, for: .primaryActionTriggered)
        mode.configuration?.baseForegroundColor = Theme.inkSky
        mode.configuration?.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = Theme.font(.subheadline)
            return attributes
        }
        mode.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            usesToken.toggle()
            showMode()
            show("", error: false)
        }, for: .primaryActionTriggered)

        let stack = UIStackView(arrangedSubviews: [title, note, fields, connect, mode, status])
        stack.axis = .vertical
        stack.spacing = Theme.Space.s4
        stack.setCustomSpacing(Theme.Space.s2, after: title)
        stack.setCustomSpacing(Theme.Space.s6, after: note)
        stack.setCustomSpacing(Theme.Space.s2, after: connect)
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

    /// 第二个框填配对码还是访问口令。
    private func showMode() {
        secret.text = nil
        if usesToken {
            secret.placeholder = "访问口令"
            secret.isSecureTextEntry = true
            secret.textContentType = .password
            secret.keyboardType = .default
            secret.autocapitalizationType = .none
            mode.configuration?.title = "用配对码"
        } else {
            secret.placeholder = "配对码，比如 7K3M-Q9TX"
            secret.isSecureTextEntry = false
            secret.textContentType = .oneTimeCode
            secret.keyboardType = .asciiCapable
            secret.autocapitalizationType = .allCharacters
            mode.configuration?.title = "手边没有连上的设备？用访问口令"
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
        if textField === server {
            secret.becomeFirstResponder()
        } else {
            tryConnect()
        }
        return true
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
                    code: usesToken || text.isEmpty ? nil : text,
                    accessToken: usesToken && !text.isEmpty ? text : nil
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
