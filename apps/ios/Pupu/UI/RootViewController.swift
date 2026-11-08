import UIKit

/// 没连过 Pupu 时先显示连接页；连上以后是带顶栏的主界面。
/// 主界面跟着身份走：换了 Pupu、重新配对，都整个换一个新的，旧的聊天和连接一起丢掉。
final class RootViewController: UIViewController {
    private var shown: (identity: Identity?, controller: UIViewController)?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.addSubview(SkyView())
        view.subviews[0].pin(to: view)
        NotificationCenter.default.addObserver(forName: Connection.changed, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.showCurrent() }
        }
        showCurrent()
    }

    private func showCurrent() {
        let identity = Connection.shared.identity
        if let shown, shown.identity == identity { return }
        let next: UIViewController = if let identity {
            UINavigationController(rootViewController: ShellViewController(identity: identity))
        } else {
            ConnectViewController()
        }
        // 设置、远程桌面这类浮层是旧身份的，先收起来，别盖在新页面上。
        if presentedViewController != nil { dismiss(animated: true) }
        overrideUserInterfaceStyle = .unspecified
        if let current = shown?.controller {
            current.willMove(toParent: nil)
            current.view.removeFromSuperview()
            current.removeFromParent()
        }
        addChild(next)
        view.addSubview(next.view)
        next.view.pin(to: view)
        next.didMove(toParent: self)
        shown = (identity, next)
    }
}
