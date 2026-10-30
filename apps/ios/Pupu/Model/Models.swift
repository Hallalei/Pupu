import Foundation

nonisolated struct Project: Decodable, Sendable, Hashable {
    let id: String
    /// 这个项目对应的 pi 会话 id。
    let session: String
    let name: String
    let goal: String
    let createdAt: Double
    let updatedAt: Double
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

nonisolated struct PupuState: Decodable, Sendable {
    let projects: [Project]
    let computers: [Computer]
    let approvals: [Approval]?
}
