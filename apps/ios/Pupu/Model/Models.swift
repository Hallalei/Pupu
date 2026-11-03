import Foundation

nonisolated struct Project: Decodable, Sendable, Hashable {
    let id: String
    /// 这个项目对应的 pi 会话 id。
    let session: String
    let name: String
    let goal: String
    /// 最新进展一句：Pupu 在这个项目里最后一次回复的第一行。还没回复过是空串；旧版云端不给。
    let progress: String?
    let createdAt: Double
    let updatedAt: Double

    /// 列表第二行：有进展说进展，没有说目标。都没有是 nil。
    var summary: String? {
        if let progress, !progress.isBlank { return progress }
        return goal.isBlank ? nil : goal
    }
}

nonisolated struct Computer: Decodable, Sendable, Hashable {
    enum Policy: String, Sendable, CaseIterable {
        case askRisky = "ask_risky"
        case askAll = "ask_all"
        case trust

        var title: String {
            switch self {
            case .askRisky: "高风险才问"
            case .askAll: "每一步都问"
            case .trust: "都放行"
            }
        }

        var detail: String {
            switch self {
            case .askRisky: "删除、push、发布、sudo 这类先问你"
            case .askAll: "跑命令、写文件、点屏幕之前都先问你"
            case .trust: "不问你，Mac 菜单栏照常显示 Pupu 在做什么"
            }
        }
    }

    let id: String
    let name: String
    /// 主人的成员 id：用谁的账号登录电脑 App 就是谁的。还没主人是 nil。
    let ownerId: String?
    let online: Bool
    /// 连着，但是心跳停了。
    let stale: Bool
    let lastSeenAt: Double?
    let policy: String?
    /// 屏幕授权还有效。
    let screen: Bool?

    var currentPolicy: Policy { policy.flatMap(Policy.init(rawValue:)) ?? .askRisky }

    var label: String {
        if online { return "在线" }
        if stale { return "心跳中断" }
        if let lastSeenAt { return "离线 · \(Ago.text(lastSeenAt))" }
        return "离线"
    }
}

nonisolated struct Approval: Decodable, Sendable, Hashable {
    let id: String
    let computerId: String
    let computerName: String
    /// step：这一步单独批；screen：这台电脑的屏幕授权。
    let kind: String
    let title: String
    let detail: String
    let reason: String?
    let createdAt: Double
    let expiresAt: Double
}

/// 配对过的手机或浏览器。
nonisolated struct Device: Decodable, Sendable, Hashable {
    let id: String
    let name: String
    /// phone、browser 或 desktop（电脑 App 的窗口）。
    let kind: String
    /// 是谁的：成员 id 和他的 Google 邮箱。不属于谁是 nil。
    let memberId: String?
    let member: String?
    let createdAt: Double
    let lastSeenAt: Double?
    /// 就是这台手机。
    let current: Bool

    /// 比如「手机 · a@gmail.com · 3 分钟前用过」。
    var label: String {
        let kind = kind == "phone" ? "手机" : kind == "desktop" ? "电脑 App" : "浏览器"
        let seen = lastSeenAt.map { "\(Ago.text($0))用过" }
        return [kind, member, seen].compactMap { $0 }.joined(separator: " · ")
    }
}

/// 测试通知的结果：每个 token 一条 APNs 的回答。
nonisolated struct PushTest: Decodable, Sendable {
    struct Result: Decodable, Sendable {
        let env: String
        let status: Int
        let reason: String?
    }

    let ok: Bool
    let error: String?
    let results: [Result]?
}

/// 给新设备用的配对码，10 分钟内有效，用一次就作废。
nonisolated struct PairingCode: Decodable, Sendable, Hashable {
    let code: String
    let expiresAt: Double
}

/// 配对换来的凭据。明文只在这一次返回。
nonisolated struct Paired: Decodable, Sendable {
    let id: String
    let name: String
    let token: String
}

/// 一台电脑现在在干什么。主页的「正在做」和锁屏的实时活动用这一份，云端 src/bridge/activity.ts 算出来。
nonisolated struct ComputerActivity: Decodable, Sendable, Hashable {
    enum State: String, Sendable {
        /// 没连上，或者心跳停了。
        case offline
        /// 有请示等你批，Pupu 停在那一步。
        case waiting
        /// 正在电脑上做事。
        case working
        /// 连着，闲着。
        case idle
    }

    struct ProjectRef: Decodable, Sendable, Hashable {
        let id: String
        let name: String
    }

    let computerId: String
    let computerName: String
    let state: String
    /// 一句话：在做什么，或者停在哪一步等你批。闲着和离线是 nil。
    let doing: String?
    /// 等批的那一步为什么算高风险。
    let reason: String?
    /// 这件事是哪个项目里的。主对话里的是 nil。
    let project: ProjectRef?
    let since: Double?
    /// 几条请示在等批。
    let pending: Int
    /// 同时在跑几件事。
    let running: Int
    /// 屏幕授权还有效。
    let screen: Bool

    var currentState: State { State(rawValue: state) ?? .idle }
}

/// 一起用这个 Pupu 的人。创建者在前（需求说明 4.7）。
nonisolated struct Member: Decodable, Sendable, Hashable {
    let id: String
    let email: String
    /// creator 或 member。
    let role: String
    /// 第一次登录的时间。邀请了还没登录过是 nil。
    let joinedAt: Double?
    /// 这台手机是他的。
    let current: Bool

    var isCreator: Bool { role == "creator" }

    var label: String {
        if isCreator { return "创建者" }
        return joinedAt == nil ? "成员 · 还没登录过" : "成员"
    }
}

nonisolated struct PupuState: Decodable, Sendable {
    let projects: [Project]
    let computers: [Computer]
    let approvals: [Approval]?
    let devices: [Device]?
    let activity: [ComputerActivity]?
    let members: [Member]?
}
