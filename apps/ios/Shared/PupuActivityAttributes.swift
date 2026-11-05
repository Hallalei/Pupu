import ActivityKit
import Foundation

/// 灵动岛和锁屏实时活动的数据。云端 src/push/live.ts 推 start、update、end，字段和它的 LiveContent 一一对应。
///
/// 结构体名就是 push-to-start 里的 attributes-type，字段名就是推送里的 key：上线后只加不改。
/// 编进 App 和小组件两边。
nonisolated struct PupuActivityAttributes: ActivityAttributes {
    /// 云端开这个活动的时间，1970 年起的秒。同时冒出两个时留新的那个。
    var startedAt: Double

    struct ContentState: Codable, Hashable, Sendable {
        enum Mode: String, Codable, Sendable {
            /// 有请示等你批，下面是「拒绝」「允许」。
            case approval
            /// Pupu 正在操作这台电脑的屏幕，右边是「收回」。
            case screen
            /// 有命令跑了 30 秒还没完。
            case command
            /// 做完了，过两分钟自己消失。
            case done
        }

        enum Icon: String, Codable, Sendable {
            case screen
            case command
        }

        var mode: Mode
        var computerId: String
        var computerName: String
        /// 大标题：「Pupu 正在操作「mbpro」的屏幕」「Pupu 想在「mbpro」上跑命令」。
        var title: String
        /// 第二行：命令或者摘要。nil 时显示已经多久。
        var detail: String?
        /// 从什么时候开始，1970 年起的秒。系统解推送时 Date 按 2001 年起算，所以用数。
        var since: Double
        var approvalId: String?
        /// 一共几条请示在等批。
        var pending: Int
        /// 屏幕授权还在：显示「收回」。
        var screen: Bool
        var icon: Icon

        var sinceDate: Date { Date(timeIntervalSince1970: since) }

        init(
            mode: Mode,
            computerId: String,
            computerName: String,
            title: String,
            detail: String?,
            since: Double,
            approvalId: String?,
            pending: Int,
            screen: Bool,
            icon: Icon
        ) {
            self.mode = mode
            self.computerId = computerId
            self.computerName = computerName
            self.title = title
            self.detail = detail
            self.since = since
            self.approvalId = approvalId
            self.pending = pending
            self.screen = screen
            self.icon = icon
        }

        /// 系统解推送的内容时，有一个字段解不出来就整条丢掉（home-assistant/iOS 踩过）。
        /// 所以都给默认值：云端以后加了新的 mode 或 icon，旧版 App 也照样显示。
        init(from decoder: any Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            mode = (try? values.decode(Mode.self, forKey: .mode)) ?? .command
            computerId = (try? values.decode(String.self, forKey: .computerId)) ?? ""
            computerName = (try? values.decode(String.self, forKey: .computerName)) ?? ""
            title = (try? values.decode(String.self, forKey: .title)) ?? "Pupu"
            detail = try? values.decodeIfPresent(String.self, forKey: .detail)
            since = (try? values.decode(Double.self, forKey: .since)) ?? Date().timeIntervalSince1970
            approvalId = try? values.decodeIfPresent(String.self, forKey: .approvalId)
            pending = (try? values.decode(Int.self, forKey: .pending)) ?? 0
            screen = (try? values.decode(Bool.self, forKey: .screen)) ?? false
            icon = (try? values.decode(Icon.self, forKey: .icon)) ?? .command
        }
    }
}
