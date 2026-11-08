import UIKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    /// 冷启动时带进来的配对链接，等界面出来再处理。
    private var pendingLink: URL?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = RootViewController()
        window.tintColor = Theme.ink
        window.makeKeyAndVisible()
        self.window = window
        pendingLink = connectionOptions.urlContexts.first?.url
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        if let url = URLContexts.first?.url { openPairLink(url) }
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        NotificationCenter.default.post(name: .pupuBecameActive, object: nil)
        if let url = pendingLink {
            pendingLink = nil
            openPairLink(url)
        }
    }

    /// 网页设置里的二维码：`pupu://pair?server=…&code=…`。链接谁都能做，所以一定先问一句，
    /// 把要连的地址摆出来，免得被别人的链接连到陌生的 Pupu。
    private func openPairLink(_ url: URL) {
        guard let link = Connection.pairLink(url) else { return }
        let host = link.server.host() ?? link.server.absoluteString
        // 同一个地址上可以有好几个 Pupu，地址一样也可能是另一个，所以照样问。
        var message = "用配对码 \(link.code) 把这台手机连到 \(link.server.absoluteString)。"
        if let current = Connection.shared.endpoint {
            message += "\n\n现在连着 \(current.base.host() ?? current.base.absoluteString)，连上新的之后会从那边注销。"
        }
        let confirm = UIAlertController(title: "连接到 \(host)？", message: message, preferredStyle: .alert)
        confirm.addAction(UIAlertAction(title: "取消", style: .cancel))
        confirm.addAction(UIAlertAction(title: "连接", style: .default) { [weak self] _ in
            Task {
                do {
                    try await Connection.shared.pair(base: link.server, code: link.code, accessToken: nil)
                } catch {
                    self?.alert(title: "没连上", message: error.localizedDescription)
                }
            }
        })
        present(confirm)
    }

    private func alert(title: String, message: String) {
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "好", style: .default))
        present(alert)
    }

    private func present(_ controller: UIViewController) {
        var top = window?.rootViewController
        while let next = top?.presentedViewController { top = next }
        top?.present(controller, animated: true)
    }
}
