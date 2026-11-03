import AppIntents
import Foundation

// 灵动岛和锁屏实时活动上的按钮。编进 App 和小组件两边：小组件只用它画按钮，
// 系统在 App 的进程里跑 perform，所以能直接拿 App 的凭据调 Pupu 的接口，不用打开 App。
// 写法参照 PiStats 的 QuickDisableIntent。真正干活的在 App 里（LiveActivities.swift），
// 小组件里没有它，用 PUPU_APP 隔开。

/// 「允许」：锁着屏要先 Face ID，和通知上的「允许」一样。
struct AllowApprovalIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "允许"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    static let isDiscoverable = false

    @Parameter(title: "请示") var approvalId: String

    init() {}

    init(approvalId: String) {
        self.approvalId = approvalId
    }

    func perform() async throws -> some IntentResult {
        #if PUPU_APP
        await LiveActivityActions.decide(approvalId, allow: true)
        #endif
        return .result()
    }
}

/// 「拒绝」：不用解锁。
struct DenyApprovalIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "拒绝"
    static let isDiscoverable = false

    @Parameter(title: "请示") var approvalId: String

    init() {}

    init(approvalId: String) {
        self.approvalId = approvalId
    }

    func perform() async throws -> some IntentResult {
        #if PUPU_APP
        await LiveActivityActions.decide(approvalId, allow: false)
        #endif
        return .result()
    }
}

/// 「收回」：立刻收回这台电脑的屏幕控制，和 Mac 菜单栏上的收回一样。不用解锁。
struct TakebackIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "收回"
    static let isDiscoverable = false

    @Parameter(title: "电脑") var computerId: String

    init() {}

    init(computerId: String) {
        self.computerId = computerId
    }

    func perform() async throws -> some IntentResult {
        #if PUPU_APP
        await LiveActivityActions.takeback(computerId)
        #endif
        return .result()
    }
}
