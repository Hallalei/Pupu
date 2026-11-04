import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    /// 只有远程桌面能横过来，别的页面都竖着。
    func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        RemoteDesktopViewController.isOpen ? .allButUpsideDown : .portrait
    }

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        Push.shared.start()
        LiveActivities.shared.start()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Push.shared.didRegister(deviceToken: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        Push.shared.didFailToRegister()
    }

    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
    }
}

extension Notification.Name {
    /// App 回到前台。断掉的连接借这个时机立刻重连，不等退避。
    static let pupuBecameActive = Notification.Name("PupuBecameActive")
}
