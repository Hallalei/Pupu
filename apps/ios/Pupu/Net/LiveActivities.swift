import ActivityKit
import Foundation

/// 灵动岛和锁屏的实时活动。开、改、关都由云端推送（src/push/live.ts），App 这边只做三件事：
/// 1. 把 push-to-start token 交给 Pupu，它才开得了活动；
/// 2. 活动开起来后，把这个活动自己的 token 交上去，之后的更新和结束推给它；活动结束或被划掉了，叫 Pupu 删掉；
/// 3. 同时冒出两个时，留云端最后开的那个（看 startedAt），别的马上收掉。
///
/// 写法参照 home-assistant/iOS 的 LiveActivityRegistry（只给留下的那个报 token）和 CodeIsland 的去重。
/// 推送启动的活动，系统会在后台把 App 叫起来，这里在 didFinishLaunching 时就开始听。
final class LiveActivities {
    static let shared = LiveActivities()

    private typealias PupuActivity = Activity<PupuActivityAttributes>

    private var started = false
    private var startToken: String?
    /// 已经在听的活动 id。
    private var watched: Set<String> = []

    func start() {
        guard !started else { return }
        started = true
        Task {
            for await data in PupuActivity.pushToStartTokenUpdates {
                startToken = Self.hex(data)
                registerStart()
            }
        }
        Task {
            for await activity in PupuActivity.activityUpdates {
                adopt(activity)
            }
        }
        for activity in PupuActivity.activities {
            adopt(activity)
        }
        // 换了配对、回到前台：再交一次，Pupu 那边删过或者换了地址也能补上。
        for name in [Connection.changed, .pupuBecameActive] {
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { LiveActivities.shared.registerAll() }
            }
        }
        #if DEBUG
        // 实时活动只能在前台开，启动时还没到前台。
        NotificationCenter.default.addObserver(forName: .pupuBecameActive, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { LiveActivities.shared.startDemoIfAsked() }
        }
        #endif
    }

    private func registerAll() {
        registerStart()
        if let current = current(), let token = current.pushToken {
            register(activity: Self.hex(token))
        }
    }

    private func registerStart() {
        guard let token = startToken, let api = Store.shared.api else { return }
        Task { try? await api.registerPush(token: token, type: "start", env: Push.environment) }
    }

    private func register(activity token: String) {
        guard let api = Store.shared.api else { return }
        Task { try? await api.registerPush(token: token, type: "activity", env: Push.environment) }
    }

    /// 还开着的活动里，云端最后开的那个。
    private func current() -> PupuActivity? {
        PupuActivity.activities
            .filter { $0.activityState == .active || $0.activityState == .stale }
            .max { $0.attributes.startedAt < $1.attributes.startedAt }
    }

    private func adopt(_ activity: PupuActivity) {
        let keep = current()?.id
        Task { await Self.endAll(except: keep) }
        guard !watched.contains(activity.id) else { return }
        watched.insert(activity.id)
        Task {
            for await data in activity.pushTokenUpdates {
                // 被去重收掉的那个不报，免得它的 token 顶掉留下的那个。
                guard current()?.id == activity.id else { continue }
                register(activity: Self.hex(data))
            }
        }
        Task {
            for await state in activity.activityStateUpdates where state == .ended || state == .dismissed {
                watched.remove(activity.id)
                if let token = activity.pushToken, let api = Store.shared.api {
                    try? await api.unregisterPush(token: Self.hex(token))
                }
                break
            }
        }
    }

    /// 收掉别的还开着的活动。不在主线程上拿着 Activity 跨过去，只传 id。
    nonisolated private static func endAll(except keep: String?) async {
        for other in Activity<PupuActivityAttributes>.activities where other.id != keep && other.activityState == .active {
            await other.end(nil, dismissalPolicy: .immediate)
        }
    }

    private static func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    #if DEBUG
    /// 模拟器收不到实时活动的推送。启动参数 `-PupuLiveActivityDemo approval|screen|command|done`
    /// 在本地开一个示例，看锁屏和灵动岛的样子。
    private func startDemoIfAsked() {
        guard let raw = UserDefaults.standard.string(forKey: "PupuLiveActivityDemo"),
              let mode = PupuActivityAttributes.ContentState.Mode(rawValue: raw),
              current() == nil
        else { return }
        let now = Date().timeIntervalSince1970
        let state: PupuActivityAttributes.ContentState
        switch mode {
        case .approval:
            state = .init(
                mode: .approval, computerId: "demo", computerName: "mbpro", title: "Pupu 想在「mbpro」上跑命令",
                detail: "git push origin main", since: now, approvalId: "demo", pending: 2, screen: false, icon: .command
            )
        case .screen:
            state = .init(
                mode: .screen, computerId: "demo", computerName: "mbpro", title: "Pupu 正在操作「mbpro」的屏幕",
                detail: nil, since: now - 180, approvalId: nil, pending: 0, screen: true, icon: .screen
            )
        case .command:
            state = .init(
                mode: .command, computerId: "demo", computerName: "mbpro", title: "Pupu 正在「mbpro」上跑命令",
                detail: "npm run build", since: now - 45, approvalId: nil, pending: 0, screen: false, icon: .command
            )
        case .done:
            state = .init(
                mode: .done, computerId: "demo", computerName: "mbpro", title: "Pupu 在「mbpro」上的事做完了",
                detail: nil, since: now, approvalId: nil, pending: 0, screen: false, icon: .command
            )
        }
        do {
            _ = try PupuActivity.request(
                attributes: PupuActivityAttributes(startedAt: now),
                content: ActivityContent(state: state, staleDate: nil)
            )
        } catch {
            print("开不了示例实时活动：\(error)")
        }
    }
    #endif
}

/// 实时活动上的按钮在 App 进程里真正干的活（LiveActivityIntents.swift 调过来）。
/// 没批上就发一条本地通知说一声，和通知上的按钮一样。
enum LiveActivityActions {
    static func decide(_ approvalId: String, allow: Bool) async {
        // 实时活动只跟着现在连着的 Pupu，按现在的凭据批。
        await Push.shared.handle(approval: approvalId, action: allow ? Push.allowAction : Push.denyAction, org: nil)
        // 通知上的那条也收掉。云端知道是这台手机批的，不会再给它推「已处理」。
        Push.shared.clearDelivered(approval: approvalId)
    }

    static func takeback(_ computerId: String) async {
        guard let api = Store.shared.api else {
            await Push.shared.tell(title: "没收回", body: "这台手机没连着 Pupu，打开 App 重新配对。")
            return
        }
        do {
            try await api.takeback(computer: computerId)
        } catch {
            await Push.shared.tell(title: "没收回", body: error.localizedDescription)
        }
        Store.shared.refresh()
    }
}
