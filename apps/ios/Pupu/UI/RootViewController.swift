import UIKit

/// 没连过 Pupu 时先显示连接页；连上以后是带顶栏的主界面。
final class RootViewController: UIViewController {
    private var current: UIViewController?

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
        let next: UIViewController
        if Connection.shared.endpoint == nil {
            if current is ConnectViewController { return }
            next = ConnectViewController()
        } else {
            if current is UINavigationController { return }
            next = UINavigationController(rootViewController: ShellViewController())
        }
        if let current {
            current.willMove(toParent: nil)
            current.view.removeFromSuperview()
            current.removeFromParent()
        }
        addChild(next)
        view.addSubview(next.view)
        next.view.pin(to: view)
        next.didMove(toParent: self)
        current = next
    }
}
