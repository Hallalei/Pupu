import UIKit
import UserNotifications

/// 推送：要通知权限、把 token 交给 Pupu，接住审批通知上的「允许」「拒绝」。
///
/// 锁屏上长按审批通知就能批：「允许」要先解锁（Face ID），「拒绝」不用。点完系统在后台把 App 叫起来，
/// 调一次 /api/approvals/:id，不用打开 App。凭据在钥匙串里是「首次解锁后可读」，锁着屏也拿得到。
final class Push: NSObject {
    static let shared = Push()
    static let changed = Notification.Name("PupuPushChanged")

    /// 和云端 src/push/approvals.ts 的 APPROVAL_CATEGORY 对应。
    static let approvalCategory = "APPROVAL"
    static let allowAction = "ALLOW"
    static let denyAction = "DENY"

    nonisolated enum Status: Hashable, Sendable {
        case unknown
        /// 还没问过要不要通知。
        case notAsked
        /// 用户在系统设置里关了。
        case off
        /// 有权限，token 还没交给 Pupu（或者没交上）。
        case registering
        case on
    }

    private(set) var status: Status = .unknown {
        didSet {
            if status != oldValue { NotificationCenter.default.post(name: Self.changed, object: nil) }
        }
    }

    /// 开发签名的包连 APNs 的 sandbox，App Store 和 TestFlight 的连 production。
    /// 看包里的描述文件：开发签名才有它，里面的 aps-environment 写着是哪个。
    static let environment: String = {
        #if targetEnvironment(simulator)
        return "sandbox"
        #else
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .isoLatin1),
              let start = text.range(of: "<?xml"),
              let end = text.range(of: "</plist>"),
              let plist = try? PropertyListSerialization.propertyList(
                  from: Data(text[start.lowerBound..<end.upperBound].utf8), format: nil
              ) as? [String: Any],
              let entitlements = plist["Entitlements"] as? [String: Any],
              let aps = entitlements["aps-environment"] as? String
        else { return "production" }
        return aps == "development" ? "sandbox" : "production"
        #endif
    }()

    /// 在 didFinishLaunching 里调：点通知按钮时 App 是在后台被叫起来的，代理要在启动完之前就设好。
    func start() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let allow = UNNotificationAction(
            identifier: Self.allowAction,
            title: "允许",
            options: [.authenticationRequired],
            icon: UNNotificationActionIcon(systemImageName: "checkmark")
        )
        let deny = UNNotificationAction(
            identifier: Self.denyAction,
            title: "拒绝",
            options: [.destructive],
            icon: UNNotificationActionIcon(systemImageName: "xmark")
        )
        center.setNotificationCategories([
            UNNotificationCategory(identifier: Self.approvalCategory, actions: [allow, deny], intentIdentifiers: [])
        ])
        NotificationCenter.default.addObserver(forName: Connection.changed, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { Push.shared.register() }
        }
        NotificationCenter.default.addObserver(forName: .pupuBecameActive, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { Push.shared.register() }
        }
        register()
    }

    /// 连着 Pupu 就要通知权限，拿到 token 交给它。每次回到前台都交一次：token 可能换了，
    /// 换了配对、Pupu 那边删了 token，也靠这一下补上。系统只在第一次弹窗问。
    func register() {
        guard Connection.shared.endpoint != nil else { return }
        Task {
            let center = UNUserNotificationCenter.current()
            var settings = await center.notificationSettings()
            if settings.authorizationStatus == .notDetermined {
                _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
                settings = await center.notificationSettings()
            }
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral:
                if status != .on { status = .registering }
                UIApplication.shared.registerForRemoteNotifications()
            case .denied:
                status = .off
            default:
                status = .notAsked
            }
        }
    }

    func didRegister(deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        guard let api = Store.shared.api else { return }
        Task {
            do {
                try await api.registerPush(token: token, type: "alert", env: Self.environment)
                status = .on
            } catch {
                status = .registering
            }
        }
    }

    func didFailToRegister() {
        status = .registering
    }

    /// 已经不在等的审批，它带按钮的通知收掉。刚到的先不动：通知可能比状态先到。
    func clearDelivered(pending: [String]) {
        let live = Set(pending)
        Task {
            let center = UNUserNotificationCenter.current()
            let stale = await center.deliveredNotifications().filter { notification in
                let content = notification.request.content
                guard content.categoryIdentifier == Self.approvalCategory,
                      let id = content.userInfo["approvalId"] as? String
                else { return false }
                return !live.contains(id) && notification.date.timeIntervalSinceNow < -30
            }
            center.removeDeliveredNotifications(withIdentifiers: stale.map(\.request.identifier))
        }
    }

    /// 在 App 里批了：这条审批的通知收掉。通知的 identifier 就是云端给的 collapse id，也就是审批 id。
    func clearDelivered(approval id: String) {
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [id])
    }

    /// 后台点了按钮却没批上，用一条本地通知说一声，不然用户以为批了。
    func tell(title: String, body: String) async {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        try? await UNUserNotificationCenter.current().add(request)
    }

    func handle(approval id: String, action: String) async {
        let allow = action == Self.allowAction
        guard let api = Store.shared.api else {
            await tell(title: "没批上", body: "这台手机没连着 Pupu，打开 App 重新配对。")
            return
        }
        do {
            try await api.decide(approval: id, allow: allow)
        } catch {
            await tell(title: allow ? "没批上" : "没拒掉", body: error.localizedDescription)
        }
        Store.shared.refresh()
    }
}

extension Push: UNUserNotificationCenterDelegate {
    /// App 在前台：审批卡片已经挂在顶上，横幅就不弹了，只进通知中心；「已处理」那条在前台不用看。
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let content = notification.request.content
        if content.userInfo["settled"] != nil {
            completionHandler([])
        } else if content.categoryIdentifier == Self.approvalCategory {
            Store.shared.refresh()
            completionHandler([.list])
        } else {
            completionHandler([.banner, .list, .sound])
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let content = response.notification.request.content
        let action = response.actionIdentifier
        guard content.categoryIdentifier == Self.approvalCategory,
              let id = content.userInfo["approvalId"] as? String,
              action == Self.allowAction || action == Self.denyAction
        else {
            // 点的是通知本身：App 打开就行，审批卡片挂在每一屏的顶上。
            Store.shared.refresh()
            completionHandler()
            return
        }
        Task {
            await handle(approval: id, action: action)
            completionHandler()
        }
    }
}
