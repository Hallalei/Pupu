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
    /// 密级 L2/L3/L4（见云端 access.ts）。旧版云端不给，算 L2。
    let level: String?
    /// 建这个空间的成员。老项目和旧版云端是 nil，谁都改不了。
    let ownerId: String?
    /// 空间成员的 id。L2 全组织可见，这张名单只在 L3、L4 决定谁能看。
    let members: [String]?
    /// direct 或 coordinator（主会话只委派）。
    let mode: String?
    /// 协调模式下派出去的子会话。
    let children: [SpaceChild]?
    /// 只有全员空间给：现在这个人能不能切「只派活」（组织创建者能）。
    let mayManage: Bool?

    /// 全员空间：原来的主会话（root），组织里的人都在。云端 projects.ts 的 EVERYONE_ID。
    static let everyoneId = "everyone"
    var isEveryone: Bool { id == Self.everyoneId }
    var delegateOnly: Bool { mode == "coordinator" }

    /// 列表第二行：有进展说进展，没有说目标。都没有是 nil。
    var summary: String? {
        if let progress, !progress.isBlank { return progress }
        return goal.isBlank ? nil : goal
    }

    /// 全组织都看得到（L2、L1，旧版云端）。
    var isOpen: Bool { level == nil || level == "L1" || level == "L2" }
    var memberIds: [String] { members ?? [] }
    var spaceChildren: [SpaceChild] { children ?? [] }

    func isOwner(_ member: String?) -> Bool { member != nil && ownerId == member }

    func child(session: String) -> SpaceChild? { spaceChildren.first { $0.session == session } }
}

/// 空间里的一个子会话：主会话派出去的一件事。云端 server.ts 的 ChildView。
nonisolated struct SpaceChild: Decodable, Sendable, Hashable {
    enum Status: Sendable {
        case working, waiting, done, idle

        var label: String {
            switch self {
            case .working: "正在做"
            case .waiting: "等你批准"
            case .done: "做完了"
            case .idle: "还没开始"
            }
        }
    }

    let session: String
    let title: String
    let createdAt: Double
    /// 派了活、还没回报。
    let busy: Bool
    /// 子会话里有电脑动作在等批准。
    let waiting: Bool?
    let reportedAt: Double?
    /// 最近一次回投的第一行。
    let summary: String?

    var status: Status {
        if waiting == true { return .waiting }
        if busy { return .working }
        return reportedAt == nil ? .idle : .done
    }

    /// 卡上的第二行：「做完了 · 价格卡改成竖排」。
    var line: String {
        if status == .done, let summary, !summary.isBlank { return "\(status.label) · \(summary)" }
        return status.label
    }
}

nonisolated struct Computer: Decodable, Sendable, Hashable {
    /// 什么时候先问你。和网页 Settings.tsx 的 POLICIES 一样的三档、一样的字。
    enum Policy: String, Sendable, CaseIterable {
        case trust
        case askRisky = "ask_risky"
        case askAll = "ask_all"

        var title: String {
            switch self {
            case .trust: "始终允许"
            case .askRisky: "高风险时询问"
            case .askAll: "每次询问"
            }
        }

        /// 越大越严。别人的电脑只能往严里改（云端的 mayChangePolicy 也这么判）。
        var strictness: Int {
            switch self {
            case .trust: 0
            case .askRisky: 1
            case .askAll: 2
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
    /// 等批的那次工具调用，对话里那一步靠它显示「等你批准」。新手机登录和老云端没有。
    let callId: String?
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
/// `/api/orgs`：这个账号在的 Pupu，`current` 是这张凭据所在的那个。
nonisolated struct OrgList: Decodable, Sendable {
    nonisolated struct Org: Decodable, Sendable, Hashable {
        let id: String
        let name: String
        let creator: String?
        let members: Int
        let role: String
        let current: Bool
    }

    let current: String
    let orgs: [Org]
    let canOpenOwn: Bool
}

nonisolated struct Paired: Decodable, Sendable {
    let id: String
    let name: String
    let token: String
}

/// 一台电脑现在在干什么。聊天顶上的「正在做」和锁屏的实时活动用这一份，云端 src/bridge/activity.ts 算出来。
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

    /// 「正在做」列哪些电脑：在做事的、停着等批的，还有闲着但屏幕控制没收回的。
    /// 屏幕控制开着的排最前：「收回」是安全出口，只摊开一行时也要看得到。
    /// 同级按 id 排：云端按心跳排，每次心跳都可能换先后。同样的规则网页写在云端 busyComputers。
    static func busy(_ all: [ComputerActivity]) -> [ComputerActivity] {
        let listed = all.filter {
            switch $0.currentState {
            case .working, .waiting: true
            case .idle: $0.screen
            case .offline: false
            }
        }.sorted { $0.computerId < $1.computerId }
        return [true, false].flatMap { screen in
            [State.waiting, .working, .idle].flatMap { state in
                listed.filter { $0.screen == screen && $0.currentState == state }
            }
        }
    }

    /// 停在哪些项目里等你批。一台电脑只带得出最早那条请示的项目。
    static func waitingProjects(_ all: [ComputerActivity]) -> Set<String> {
        Set(all.compactMap { $0.currentState == .waiting ? $0.project?.id : nil })
    }
}

/// 一起用这个 Pupu 的人。创建者在前（需求说明 4.7）。
nonisolated struct Member: Decodable, Sendable, Hashable {
    let id: String
    let email: String
    /// 显示的名字。旧版云端不给。
    let name: String?
    /// creator 或 member。
    let role: String
    /// 第一次登录的时间。邀请了还没登录过是 nil。
    let joinedAt: Double?
    /// 换过的头像，相对这个 Pupu 的地址（见云端 avatars.ts）。没换过、旧版云端不给是 nil，显示名字的第一个字。
    let avatar: String?
    /// 这台手机是他的。
    let current: Bool

    var isCreator: Bool { role == "creator" }
    /// 显示的名字，没有就用邮箱 @ 前面那段，和云端 memberName 一样。
    var displayName: String { name ?? email.split(separator: "@").first.map(String.init) ?? email }

    var label: String {
        if isCreator { return "创建者" }
        return joinedAt == nil ? "成员 · 还没登录过" : "成员"
    }
}

/// 开新 Pupu 的邀请码，云端 directory.ts 的 InviteList。`left` 是还能生成几个。
nonisolated struct InviteList: Decodable, Sendable, Hashable {
    struct Invite: Decodable, Sendable, Hashable {
        var code: String
        let createdAt: Double
        /// 用这个码开了 Pupu 的人的邮箱。没用过是 nil。
        let usedBy: String?
        let usedAt: Double?
    }

    var invites: [Invite]
    var left: Int
}

/// 项目报回聊天的结果，云端 src/reports.ts 算好：同一个项目没看过的几条已经合成一张。
nonisolated struct ReportCard: Decodable, Sendable, Hashable {
    enum Status: String, Sendable {
        case done, blocked, failed

        /// 卡片上的状态：做完了 / 卡住了要你定 / 出错了。
        var label: String {
            switch self {
            case .done: "做完了"
            case .blocked: "卡住了要你定"
            case .failed: "出错了"
            }
        }
    }

    let id: String
    /// 这张卡该出现的聊天 session。旧版云端不给，算大家那条。
    let chat: String?
    let projectId: String
    let projectName: String
    let status: String
    /// 一句结果。
    let summary: String
    /// 转交过去的事。
    let task: String
    /// 报回来的时间，按它穿插在聊天的消息之间。
    let at: Double
    /// 用户打开过这个项目。
    let seen: Bool
    /// 合进来的、更早的几条没看过的报告。
    let more: Int

    var currentStatus: Status { Status(rawValue: status) ?? .done }

    /// 引用回复这张卡时引用里写的话。带上项目名，聊天里的 Pupu 才知道在说哪个项目；和网页的 reportQuote 一样。
    var quote: String { "项目「\(projectName)」的报告 · \(currentStatus.label)：\(summary)" }
}

/// 「我 → 账户」：成员连给 Pupu 的 Gmail、日历、GitHub 这类账号。凭据在 open-connector，见云端 src/connectors/。
nonisolated struct Connectors: Decodable, Sendable, Hashable {
    nonisolated struct Service: Decodable, Sendable, Hashable {
        /// open-connector 的 provider id，比如 gmail。
        let id: String
        let name: String
        let detail: String

        /// 列表上的图标。
        var symbol: String {
            switch id {
            case "gmail": "envelope"
            case "googlecalendar": "calendar"
            case "googledrive": "folder"
            case "github": "chevron.left.forwardslash.chevron.right"
            default: "link"
            }
        }
    }

    nonisolated struct Account: Decodable, Sendable, Hashable {
        let id: String
        let service: String
        let name: String
        /// 邮箱或用户名。没拿到是 nil。
        let account: String?
        let memberId: String?
        let ownerEmail: String?
        /// 这台手机的人能不能断开：自己的，或者是创建者。
        let removable: Bool
        let createdAt: Double
    }

    /// Pupu 这边配没配 open-connector。
    let enabled: Bool
    let services: [Service]
    let accounts: [Account]

    static let empty = Connectors(enabled: false, services: [], accounts: [])
}

/// 输入框的提示和空聊天里 Pupu 的开场白。「我的 Pupu」是自己的私聊；全员是原来的主会话，排在空间第一个。
nonisolated enum ChatCopy {
    static let everyoneHint = "发给组织里所有人和 Pupu"
    static let privateHint = "只发给 Pupu"
    static let everyoneIntro = "组织里的人都看得到这里。\n小事我直接办，要持续推进的事放进空间里。"
    static let privateIntro = "这里只有你和我，别人看不到。\n小事我直接办，要持续推进的事放进空间里。"
}

/// 这台手机能进的两条聊天。
nonisolated struct Chats: Decodable, Sendable, Hashable {
    struct Chat: Decodable, Sendable, Hashable {
        let session: String
        /// Pupu 在这条聊天最后回复的时间。还没回复过是 nil。
        let lastAt: Double?
    }

    let main: Chat
    /// 没有成员身份时是 nil，界面不给切换。
    let `private`: Chat?

    /// 云端还没给 chats 时：只有全员这一条。
    static let mainOnly = Chats(main: Chat(session: "1", lastAt: nil), private: nil)

    /// 「我的 Pupu」打开的那条：自己的私聊；没有成员身份时退回全员那条。
    var own: Chat { self.private ?? main }
}

nonisolated struct PupuState: Decodable, Sendable {
    let projects: [Project]
    /// 全员空间。旧版云端不给。
    let everyone: Project?
    /// 旧版云端不给。
    let chats: Chats?
    let computers: [Computer]
    let approvals: [Approval]?
    let devices: [Device]?
    let activity: [ComputerActivity]?
    let members: [Member]?
    let connectors: Connectors?
    /// 旧版云端不给。
    let reports: [ReportCard]?
    /// 能选的预设头像。旧版云端不给。
    let avatarPresets: [AvatarPreset]?
    /// Pupu 换过的头像地址，没换过或旧版云端是 nil。
    let pupuAvatar: String?
}

/// 预设头像：Pupu 衍生的像素猫。`url` 相对这个 Pupu 的地址。
nonisolated struct AvatarPreset: Decodable, Sendable, Hashable {
    let id: String
    let name: String
    let url: String
}
