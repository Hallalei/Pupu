import UIKit

/// 第一次打开：填 Pupu 的地址和访问口令。连得上才保存。
final class ConnectViewController: UIViewController, UITextFieldDelegate {
    private let server = UITextField()
    private let token = UITextField()
    private let status = UILabel(style: .subheadline, color: Theme.inkMuted, lines: 0)
    private let connect = UIButton.action(title: "连接")

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear

        let title = UILabel(text: "连接 Pupu", style: .greeting, color: Theme.inkSky)
        let note = UILabel(
            text: "填你部署的 Pupu 的地址和访问口令。口令存在这台手机的钥匙串里。",
            style: .message,
            color: Theme.inkSky,
            lines: 0
        )

        configure(server, placeholder: "地址，比如 https://pupu.example.workers.dev")
        server.text = Connection.shared.endpoint?.base.absoluteString ?? Connection.suggestedServer
        server.keyboardType = .URL
        server.textContentType = .URL
        server.returnKeyType = .next
        configure(token, placeholder: "访问口令（连本机的开发服务器时不用填）")
        token.isSecureTextEntry = true
        token.textContentType = .password
        token.returnKeyType = .go

        let fields = UIStackView(arrangedSubviews: [field(server), field(token)])
        fields.axis = .vertical
        fields.spacing = Theme.Space.s3

        connect.addAction(UIAction { [weak self] _ in self?.tryConnect() }, for: .primaryActionTriggered)

        let stack = UIStackView(arrangedSubviews: [title, note, fields, connect, status])
        stack.axis = .vertical
        stack.spacing = Theme.Space.s4
        stack.setCustomSpacing(Theme.Space.s2, after: title)
        stack.setCustomSpacing(Theme.Space.s6, after: note)
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
            stack.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor, constant: -40),
            connect.heightAnchor.constraint(greaterThanOrEqualToConstant: 50)
        ])
        view.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 0, leading: Theme.Space.s4, bottom: 0, trailing: Theme.Space.s4)
    }

    private func configure(_ field: UITextField, placeholder: String) {
        field.placeholder = placeholder
        field.font = Theme.font(.body)
        field.adjustsFontForContentSizeCategory = true
        field.textColor = Theme.ink
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
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
            token.becomeFirstResponder()
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
        let secret = token.text?.trimmingCharacters(in: .whitespacesAndNewlines)
        let endpoint = Endpoint(base: base, token: secret?.isEmpty == false ? secret : nil)
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
                _ = try await API(endpoint: endpoint).state()
                Connection.shared.save(endpoint)
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
