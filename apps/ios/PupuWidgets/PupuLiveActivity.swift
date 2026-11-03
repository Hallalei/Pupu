import ActivityKit
import SwiftUI
import WidgetKit

/// 灵动岛和锁屏上的 Pupu：在哪台电脑上、在做什么，有请示时在上面就能批，操作屏幕时能收回。
/// 照「Pupu 设计规范」的 LiveActivity：底是 island（黑），字和图标是 on-island（白）。
/// 这是 App 里唯一用 SwiftUI 的地方。
struct PupuLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: PupuActivityAttributes.self) { context in
            LockScreenView(state: context.state)
                .activityBackgroundTint(.island)
                .activitySystemActionForegroundColor(.onIsland)
        } dynamicIsland: { context in
            let state = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    ActionMark(state: state)
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    Headline(state: state)
                }
                // 右上角太窄，「收回」会被挤成竖条，所以和「拒绝」「允许」一样放在下面一整排。
                DynamicIslandExpandedRegion(.bottom) {
                    if let approvalId = state.approvalId, state.mode == .approval {
                        ApprovalButtons(approvalId: approvalId)
                            .padding(.top, 8)
                    } else if state.showsTakeback {
                        TakebackButton(computerId: state.computerId, wide: true)
                            .padding(.top, 8)
                    }
                }
            } compactLeading: {
                ActionIcon(state: state)
            } compactTrailing: {
                if state.mode == .approval {
                    WarningDot()
                } else {
                    Text(state.computerName)
                        .font(.caption)
                        .lineLimit(1)
                        .frame(maxWidth: 64)
                }
            } minimal: {
                if state.mode == .approval {
                    WarningDot()
                } else {
                    ActionIcon(state: state)
                }
            }
            .keylineTint(.onIsland)
        }
    }
}

extension Color {
    /// 设计规范的 island 和 on-island：系统固定的黑底白字。
    static let island = Color.black
    static let onIsland = Color.white
    /// 设计规范的 warning 在深色里的值。实时活动的底总是黑的，所以只用这一个。
    static let islandWarning = Color(red: 0.969, green: 0.718, blue: 0.314)
}

extension PupuActivityAttributes.ContentState {
    /// 屏幕授权还在、又不在等批时，右边放「收回」。
    var showsTakeback: Bool { screen && mode != .approval && mode != .done }

    var symbol: String {
        if mode == .done { return "checkmark" }
        return icon == .screen ? "cursorarrow.rays" : "terminal"
    }
}

/// 紧凑态左边的动作图标。
private struct ActionIcon: View {
    let state: PupuActivityAttributes.ContentState

    var body: some View {
        Image(systemName: state.symbol)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(Color.onIsland)
    }
}

/// 展开态和锁屏左边的圆：等批时是 warning 圆点，其余是动作图标。
private struct ActionMark: View {
    let state: PupuActivityAttributes.ContentState

    var body: some View {
        ZStack {
            Circle().fill(Color.onIsland.opacity(0.14))
            if state.mode == .approval {
                Circle().fill(Color.islandWarning).frame(width: 10, height: 10)
            } else {
                Image(systemName: state.symbol)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Color.onIsland)
            }
        }
        .frame(width: 36, height: 36)
    }
}

private struct WarningDot: View {
    var body: some View {
        Circle()
            .fill(Color.islandWarning)
            .frame(width: 8, height: 8)
    }
}

/// 大标题和下面一行：等批时是命令，操作屏幕时是已经多久，跑命令时是在跑什么。
private struct Headline: View {
    let state: PupuActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(state.title)
                .font(.headline)
                .lineLimit(2)
            footnote
                .font(.footnote)
                .foregroundStyle(Color.onIsland.opacity(0.7))
                .lineLimit(2)
        }
        .foregroundStyle(Color.onIsland)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var footnote: some View {
        switch state.mode {
        case .approval:
            let more = state.pending > 1 ? " · 还有 \(state.pending - 1) 条" : ""
            Text((state.detail ?? "") + more)
        case .screen:
            Text("已经 \(Text(state.sinceDate, style: .relative)) · 空闲 15 分钟自动收回")
        case .command:
            // 跑满 30 秒才会出现，所以跑了多久总要带上。
            let elapsed = Text("已经 \(Text(state.sinceDate, style: .relative))")
            if let detail = state.detail {
                Text("\(detail) · \(elapsed)")
            } else {
                elapsed
            }
        case .done:
            EmptyView()
        }
    }
}

private struct TakebackButton: View {
    let computerId: String
    /// 灵动岛展开时占满一排；锁屏上靠右，按字宽。
    var wide = false

    var body: some View {
        Button(intent: TakebackIntent(computerId: computerId)) {
            Text("收回")
                .frame(maxWidth: wide ? .infinity : nil)
        }
        .buttonStyle(IslandButtonStyle(prominent: false))
        .fixedSize(horizontal: !wide, vertical: false)
    }
}

private struct ApprovalButtons: View {
    let approvalId: String

    var body: some View {
        HStack(spacing: 8) {
            Button(intent: DenyApprovalIntent(approvalId: approvalId)) {
                Text("拒绝")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(IslandButtonStyle(prominent: false))
            Button(intent: AllowApprovalIntent(approvalId: approvalId)) {
                Text("允许")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(IslandButtonStyle(prominent: true))
        }
    }
}

/// 实时活动上的胶囊按钮。系统的玻璃按钮在这里画不出底，浅色模式下字还会变黑，黑底上就看不见了，
/// 所以自己画：次要的是半透明白底白字，主要的是白底黑字（设计规范「墨色主操作」在黑底上反过来）。
private struct IslandButtonStyle: ButtonStyle {
    let prominent: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(prominent ? Color.island : Color.onIsland)
            .padding(.vertical, 9)
            .padding(.horizontal, 12)
            .background(
                Capsule().fill(prominent ? Color.onIsland : Color.onIsland.opacity(0.18))
            )
            .opacity(configuration.isPressed ? 0.6 : 1)
    }
}

/// 锁屏上的卡片：左边圆、中间标题、右边「收回」；等批时下面一排「拒绝」「允许」。
/// 灵动岛展开时「收回」也在下面一排，见上面。
private struct LockScreenView: View {
    let state: PupuActivityAttributes.ContentState

    var body: some View {
        VStack(spacing: 12) {
            HStack(spacing: 12) {
                ActionMark(state: state)
                Headline(state: state)
                if state.showsTakeback {
                    TakebackButton(computerId: state.computerId)
                }
            }
            if let approvalId = state.approvalId, state.mode == .approval {
                ApprovalButtons(approvalId: approvalId)
            }
        }
        .padding(16)
    }
}
