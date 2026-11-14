import CoreGraphics
import Foundation

/// 聊天列表里的一行。一条 Pupu 的消息会拆成好几行：正文、项目标签、电脑上的操作。聊天里还有项目报回来的结果。
/// 思考过程不显示，跟聊天软件一样只看回复。
nonisolated struct ChatRow: Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        /// 我发的消息；quote 是开头引用的那段。
        case user(body: String, quote: String?)
        /// 别人发的消息。avatar 是他现在的头像（按成员 id 从名单里查），换了头像旧消息也跟着换。
        case other(body: String, quote: String?, sender: Sender, avatar: String?)
        /// Pupu 的正文，Markdown。
        case assistant(String)
        /// Pupu 还没出字：一个只有三个点的气泡。
        case typing(retrying: Bool)
        case projectTag(name: String, projectId: String?)
        /// 电脑上的一步。拼行时都收进 `computer` 那张卡里，单独出现只是还没合卡的中间状态。
        case tool(ToolStep)
        /// Pupu 在一台电脑上连着做的几步，画成一张卡。
        case computer(ComputerTask)
        /// 一段连着的浏览器操作，画成一张卡片：实时画面、状态、计划、做完后的一句结果。
        case browser(BrowserTask)
        case notice(String)
        /// 项目会话里，从聊天转来的事。
        case handoff(String)
        /// 聊天里，项目报回来的结果。
        case report(ReportCard)
        /// 协调模式的主会话派出去的一件事，点进子会话。拼完行以后，连着的几件合成一块 `tasks`。
        case task(SpaceTask)
        /// 连着派出去的几件事，列成一块（规范 TaskList）。
        case tasks([SpaceTask])
        case error(String)
        /// 时间分隔线：和上一条消息隔了 `ChatRows.timeGap` 以上的那条前面画一条。值是毫秒。
        case time(Double)
    }

    let id: String
    var kind: Kind
    /// 和上一行的间距：同一条消息里 8，消息之间 12。
    var gap: CGFloat = 12
}

/// Pupu 在电脑上做的一步。
nonisolated struct ToolStep: Equatable, Sendable {
    enum Status: Equatable, Sendable {
        case running, waiting, done, failed, denied, expired, unfinished
    }

    let callId: String
    let computer: String?
    let icon: String
    let title: String
    let status: Status
    let output: String
    let outputPath: String?
    var expanded: Bool
    /// 这一步带回来的截图，没有是 nil。
    var image: StepImage? = nil
    /// 用了屏幕（`computer_` 开头的工具）。用过屏幕的那几步画成电脑卡，只跑命令、读写文件的画成工具卡片。
    var screen: Bool = false
    /// 发起这一步的那条回复的时间（毫秒），不知道是 0。
    var at: Double = 0
}

/// 浏览器任务卡片。和网页的 chat-rows.ts 里的 BrowserTask 是同一套规则，两边一起改。
nonisolated struct BrowserTask: Equatable, Sendable {
    /// live：正在做。waiting：停在一步等批。handover：交给人了、在等人接手（画面留着，有「接手」）。
    /// done：做完了。stopped：这一轮停了、没给结果。failed：最后一步出错了。
    enum State: Equatable, Sendable { case live, waiting, handover, done, stopped, failed }
    struct PlanStep: Equatable, Sendable {
        let text: String
        let done: Bool
    }

    let id: String
    let computerId: String?
    let computer: String?
    let state: State
    /// 卡片下面那一行，比如「正在浏览 example.com」「正在阅读页面」。
    let status: String
    let plan: [PlanStep]
    let result: String?
    let steps: [ToolStep]

    var active: Bool { state == .live || state == .waiting }
    /// 交给人了、在等人接手：没有转圈，画面留着，多一个「接手」。
    var holding: Bool { state == .handover }
}

/// 电脑任务卡：在哪台电脑上、在做什么、状态；带回过截图就显示最近的画面，点「步骤」看每一步。
/// 和网页的 chat-rows.ts 里的 ComputerTask 是同一套规则，两边一起改。
nonisolated struct ComputerTask: Equatable, Sendable {
    /// live：这一轮还在跑，这是最后一张电脑卡。waiting：有一步在等批。done：都做完了。
    /// failed：最后一步出错了。stopped：这一轮停在半路。
    enum State: Equatable, Sendable { case live, waiting, done, failed, stopped }

    let id: String
    let computerId: String?
    let computer: String?
    let state: State
    /// 右上角那几个字。电脑卡：「正在用」「等你批准」「用完了」「出错了」「已停下」。
    /// 工具卡片：做完了不写字；「等你批准」「失败」「2 件没成」「没做完」；正在做是转圈。
    let status: String
    /// 这几步里有用屏幕的：画成电脑卡（规范 ComputerCard），不然画成工具卡片（ToolCallCard）。
    let usesScreen: Bool
    /// 卡片下沿那一行：最近的一步，不带电脑名。
    let latest: String
    let steps: [ToolStep]
    /// 最近一张截图。
    let screen: StepImage?
    var expanded: Bool
}

/// 主会话里的一张任务卡：派给哪个子会话、现在怎样了。状态从项目的 children 里查。
nonisolated struct SpaceTask: Equatable, Sendable {
    let session: String
    let title: String
    let status: SpaceChild.Status
    /// 第二行：「正在做」「做完了 · 一句结果」。
    let line: String
}

/// 拼行时要用到的会话之外的东西。
nonisolated struct ChatContext: Sendable {
    /// 只有聊天里挂项目标签。
    var projectTags: Bool
    var projects: [Project] = []
    var computers: [Computer] = []
    var approvals: [Approval] = []
    var members: [Member] = []
    /// 该出现在这条聊天里的项目报告，按时间先后。项目里没有。
    var reports: [ReportCard] = []
    /// 用户点开或收起过的行，和默认状态相反。
    var toggled: Set<String> = []
}

nonisolated enum ChatRows {
    /// 两条消息隔了这么久（毫秒），中间画一条时间分隔线。规范只说「隔了一段时间」，和网页一样取半小时。
    static let timeGap: Double = 30 * 60_000

    private struct Result {
        let text: String
        let details: JSON?
        let error: Bool
        let image: StepImage?
    }

    static func build(_ view: SessionView, context: ChatContext) -> [ChatRow] {
        var results: [String: Result] = [:]
        for message in view.messages where message.role == .tool {
            for case let .toolResult(id, _, text, details, error, image) in message.parts {
                results[id] = Result(text: text, details: details, error: error, image: image)
            }
        }
        let outputs = Dictionary(view.tools.map { ($0.callId, $0.output) }, uniquingKeysWith: { _, last in last })

        var messages = view.messages.filter(isVisible)
        if let live = view.live, isVisible(live) { messages.append(live) }
        let retried = retriedFailures(messages, running: view.running)

        var reports = context.reports[...]
        var rows: [ChatRow] = []
        /// 浏览器的那几步：按行 id 记下动作和参数，下面合成卡片。
        var marks: [String: BrowserMark] = [:]
        /// 上一条有时间的消息是什么时候，决定要不要画时间分隔线。
        var lastAt: Double = 0
        for message in messages where !retried.contains(message.id) {
            // 报告卡按时间穿插：排在它之后的第一条消息前面。系统记录没有时间，不算。
            while let report = reports.first, message.timestamp > 0, report.at <= message.timestamp {
                rows.append(reportRow(report))
                reports.removeFirst()
            }
            var own: [ChatRow] = []
            switch message.role {
            case .user:
                let text = message.text
                if let task = SpecialMessage.handoff(text) {
                    own.append(ChatRow(id: message.id, kind: .handoff(task)))
                } else if let notice = SpecialMessage.notice(text) {
                    // 界面上只放第一句，命令输出留给模型看。
                    let line = notice.split(separator: "\n", maxSplits: 1).first.map(String.init) ?? ""
                    own.append(ChatRow(id: message.id, kind: .notice(line)))
                } else {
                    let split = SpecialMessage.splitQuote(text)
                    let kind: ChatRow.Kind = if let sender = otherSender(message, context: context) {
                        .other(
                            body: split.body,
                            quote: split.quote,
                            sender: sender,
                            avatar: context.members.first { $0.id == sender.id }?.avatar
                        )
                    } else {
                        .user(body: split.body, quote: split.quote)
                    }
                    own.append(ChatRow(id: message.id, kind: kind))
                }
            case .notice:
                own.append(ChatRow(id: message.id, kind: .notice(message.text)))
            case .assistant:
                for (index, part) in message.parts.enumerated() {
                    let id = "\(message.id)#\(index)"
                    switch part {
                    case .text(let text) where !text.isBlank:
                        own.append(ChatRow(id: id, kind: .assistant(text)))
                    case .toolCall(let callId, let name, let arguments) where name == "browser_plan":
                        let planId = "plan:\(callId)"
                        marks[planId] = BrowserMark(op: "plan", arguments: arguments)
                        own.append(ChatRow(id: planId, kind: .assistant("")))
                    case .toolCall(let callId, let name, let arguments):
                        if let row = toolRow(
                            callId: callId,
                            name: name,
                            arguments: arguments,
                            result: results[callId],
                            output: outputs[callId],
                            running: view.running,
                            context: context,
                            at: message.timestamp
                        ) {
                            if name.hasPrefix("browser_") {
                                marks[row.id] = BrowserMark(op: String(name.dropFirst(8)), arguments: arguments)
                            }
                            own.append(row)
                        }
                    default:
                        break
                    }
                }
                if let error = message.error, !error.isBlank {
                    own.append(ChatRow(id: "\(message.id)#error", kind: .error(modelErrorText(error))))
                }
                // 这一轮被人停掉了（卡片上的停止、「取消任务」）：浏览器卡片据此显示「已停下」。这一行合卡片时就去掉了。
                if message.stopReason == "aborted" {
                    let abortedId = "aborted:\(message.id)"
                    marks[abortedId] = BrowserMark(op: "aborted", arguments: .null)
                    own.append(ChatRow(id: abortedId, kind: .assistant("")))
                }
            case .tool:
                break
            }
            if !own.isEmpty, message.timestamp > 0, message.role == .user || message.role == .assistant {
                if lastAt > 0, message.timestamp - lastAt >= timeGap {
                    rows.append(ChatRow(id: "time:\(message.id)", kind: .time(message.timestamp)))
                }
                lastAt = message.timestamp
            }
            for index in own.indices { own[index].gap = index == 0 ? 12 : 8 }
            rows += own
        }
        rows += reports.map(reportRow)
        rows = browserCards(rows, marks: marks, running: view.running, context: context)
        rows = computerCards(rows, running: view.running, context: context)
        rows = taskLists(rows)
        if view.running && !(view.live?.hasText ?? false) {
            rows.append(ChatRow(id: "typing", kind: .typing(retrying: view.retry != nil)))
        }
        // 模型出错没回上时，那条回答自己已经带着原因，这里不再重复一行。
        if let error = view.error, error != "这条消息没有得到回复：model_error" {
            rows.append(ChatRow(id: "session-error", kind: .error("出错了：\(error)")))
        }
        if !rows.isEmpty { rows[0].gap = 0 }
        var seen = Set<String>()
        return rows.filter { seen.insert($0.id).inserted }
    }

    /// 这条消息要标出是谁发的时，返回发送者。自己发的、没记发送者的老消息、只有一个成员时都是 nil，靠右照旧。
    private static func otherSender(_ message: Message, context: ChatContext) -> Sender? {
        guard let sender = message.sender, context.members.count > 1 else { return nil }
        return context.members.contains { $0.current && $0.id == sender.id } ? nil : sender
    }

    private static func reportRow(_ card: ReportCard) -> ChatRow {
        ChatRow(id: "report:\(card.id)", kind: .report(card))
    }

    /// 模型出错后自动重试了的那几次：后面紧跟着下一次回答，或者现在正在重试。
    /// pi 把每次失败都记进对话，跟聊天软件一样只留最后的结果；重试期间打字气泡会写「模型忙，正在重试」。
    private static func retriedFailures(_ messages: [Message], running: Bool) -> Set<String> {
        var ids = Set<String>()
        for (index, message) in messages.enumerated() where message.role == .assistant {
            guard let error = message.error, !error.isBlank else { continue }
            let next = messages[(index + 1)...].first { $0.role != .notice }
            if next.map({ $0.role == .assistant }) ?? running { ids.insert(message.id) }
        }
        return ids
    }

    /// 模型报的错是 `503: {"message": …}` 这种给程序看的，换成人话。
    static func modelErrorText(_ error: String) -> String {
        let status = Int(error.trimmingCharacters(in: .whitespaces).prefix(3)) ?? 0
        let lower = error.lowercased()
        if status == 429 || lower.contains("rate limit") { return "模型那边限流了，这条没回上。过一会儿再发一次。" }
        if status == 402 || lower.contains("insufficient balance") { return "模型账户的余额用完了，这条没回上。充值以后再发一次。" }
        if status == 401 || status == 403 { return "模型的 key 用不了了，这条没回上。" }
        if status >= 500 || lower.contains("busy") || lower.contains("overloaded") {
            return "模型那边太忙，这条没回上。过一会儿再发一次。"
        }
        return "模型出错了，这条没回上：\(errorDetail(error))"
    }

    /// 原文里能看懂的那句：JSON 里的 message，没有就是原文，太长截断。
    private static func errorDetail(_ error: String) -> String {
        var detail = error.trimmingCharacters(in: .whitespacesAndNewlines)
        if let start = error.firstIndex(of: "{"),
           let object = try? JSONSerialization.jsonObject(with: Data(error[start...].utf8)) as? [String: Any] {
            let message = object["message"] as? String ?? (object["error"] as? [String: Any])?["message"] as? String
            if let message, !message.isBlank { detail = message.trimmingCharacters(in: .whitespacesAndNewlines) }
        }
        return detail.count > 200 ? String(detail.prefix(200)) + "…" : detail
    }

    /// 工具结果和系统记录不单独显示：项目标签和电脑上的操作已经在工具调用那里画出来了。
    static func isVisible(_ message: Message) -> Bool {
        switch message.role {
        case .tool: false
        case .notice: !message.parts.isEmpty
        case .user, .assistant: true
        }
    }

    private static func toolRow(
        callId: String,
        name: String,
        arguments: JSON,
        result: Result?,
        output: String?,
        running: Bool,
        context: ChatContext,
        at: Double
    ) -> ChatRow? {
        switch name {
        case "create_project":
            guard context.projectTags, let projectName = arguments["name"]?.string, !projectName.isBlank else { return nil }
            let project = context.projects.first { $0.name == projectName }
            return ChatRow(id: "tag:\(callId)", kind: .projectTag(name: projectName, projectId: project?.id))
        case "delegate":
            guard let session = result?.details?["session"]?.idString else {
                // 派失败了（工具报错，没有子会话）就不画这一行，不然一直挂着「正在派」；为什么没派成由回复的话说。和网页 chat-rows.ts 一起改。
                if result?.error == true { return nil }
                let title = arguments["title"]?.string ?? "派出去的事"
                return ChatRow(id: "task:\(callId)", kind: .task(SpaceTask(session: "", title: title, status: .working, line: "正在派")))
            }
            let child = context.projects.lazy.compactMap { $0.child(session: session) }.first
            let title = child?.title ?? result?.details?["title"]?.string ?? arguments["title"]?.string ?? "派出去的事"
            let status = child?.status ?? .working
            return ChatRow(id: "task:\(callId)", kind: .task(SpaceTask(session: session, title: title, status: status, line: child?.line ?? status.label)))
        case "hand_off_to_project":
            guard context.projectTags,
                  let id = arguments["project_id"]?.idString,
                  let project = context.projects.first(where: { $0.id == id })
            else { return nil }
            return ChatRow(id: "tag:\(callId)", kind: .projectTag(name: project.name, projectId: project.id))
        default:
            guard let action = ToolAction(name: name, arguments: arguments) else { return nil }
            let computerId = arguments["computer_id"]?.string ?? result?.details?["computerId"]?.string
            let computer = computerId.flatMap { id in context.computers.first { $0.id == id } }
                ?? (context.computers.count == 1 ? context.computers.first : nil)

            let status = stepStatus(callId: callId, result: result, running: running, approvals: context.approvals)
            let place = computer.map { "在「\($0.name)」上" } ?? "在电脑上"
            let did = status == .done || status == .failed
            let id = "tool:\(callId)"
            return ChatRow(id: id, kind: .tool(ToolStep(
                callId: callId,
                computer: computer?.name ?? computerId,
                icon: action.icon,
                title: place + action.verb + (did ? "了" : "") + action.object,
                status: status,
                output: readable(String((result?.text ?? output ?? "").prefix(4000)), status: status),
                outputPath: result?.details?["outputPath"]?.string,
                expanded: (status == .failed) != context.toggled.contains(id),
                image: result?.image,
                screen: name.hasPrefix("computer_"),
                at: at
            )))
        }
    }

    /// 一步走到哪了。有结果看结果；还没有结果时，有审批对着这次调用就是在等批，这一轮还在跑就是在做。
    /// 审批按调用 id 对，不按电脑：同一台电脑上别的会话在等批，不关这一步的事。
    private static func stepStatus(callId: String, result: Result?, running: Bool, approvals: [Approval]) -> ToolStep.Status {
        if let result {
            switch blockedOutcome(result.text) {
            case .denied: return .denied
            case .expired: return .expired
            // 等批准时这一轮停了，这一步算没做完。
            case .aborted: return .unfinished
            case nil: break
            }
            return result.error ? .failed : .done
        }
        if approvals.contains(where: { $0.callId == callId }) { return .waiting }
        return running ? .running : .unfinished
    }

    /// pi-durable 把拦下的调用写成 `<harness>[error] Tool call blocked: …</harness>`，那是给模型看的。
    /// 卡片里只留人看得懂的话；没批准的一步只留原因。
    static func readable(_ text: String, status: ToolStep.Status) -> String {
        var lines: [String] = []
        var inside = false
        for line in text.components(separatedBy: "\n") {
            switch line.trimmingCharacters(in: .whitespaces) {
            case "<harness>":
                inside = true
            case "</harness>":
                inside = false
            default:
                guard inside, line.hasPrefix("["), let close = line.firstIndex(of: "]") else {
                    lines.append(line)
                    continue
                }
                var message = line[line.index(after: close)...].trimmingCharacters(in: .whitespaces)
                let blocked = "Tool call blocked: "
                if message.hasPrefix(blocked) { message.removeFirst(blocked.count) }
                lines.append(message)
            }
        }
        let result = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        if status != .done, status != .failed, let cut = result.range(of: notRun) {
            return String(result[..<cut.lowerBound]) + "，这一步没有做。"
        }
        return result
    }

    /// 没批准的调用只有一段文字：pi-durable 把 gate 给的原因原样记下，不带 details。
    /// 照抄 apps/cloud/src/bridge/blocked.ts 的 `blockedOutcome`，改了要一起改。
    private enum Blocked { case denied, expired, aborted }
    private static let notRun = "，没有执行："

    private static func blockedOutcome(_ text: String) -> Blocked? {
        guard let cut = text.range(of: notRun) else { return nil }
        let why = text[..<cut.lowerBound]
        if why.hasSuffix("已经作废") { return .expired }
        if why.hasSuffix("这一轮停下了") { return .aborted }
        return .denied
    }

    struct BrowserMark {
        let op: String
        let arguments: JSON
    }

    /// 把浏览器的几步合成卡片：卡片放在第一步的位置，后面的浏览器步骤和计划都收进去，中间说的话照常显示。
    /// 用户发了新消息、项目报回结果、系统通知，就算下一件事，另起一张。
    private static func browserCards(_ rows: [ChatRow], marks: [String: BrowserMark], running: Bool, context: ChatContext) -> [ChatRow] {
        struct Open {
            let index: Int
            let id: String
            var steps: [(ToolStep, BrowserMark)] = []
            var plans: [JSON] = []
            /// 后面有人说了话（或者报回、通知），这件事算过去了。
            var closed = false
            /// 人点了「取消任务」：这一轮被停掉了，或者替人说了不做了。
            var cancelled = false
        }
        var result: [ChatRow] = []
        var cards: [Open] = []
        var open: Int?
        for row in rows {
            if let mark = marks[row.id] {
                if open == nil {
                    if mark.op == "aborted" { continue }
                    let raw = row.id.hasPrefix("tool:") ? String(row.id.dropFirst(5)) : row.id.hasPrefix("plan:") ? String(row.id.dropFirst(5)) : row.id
                    cards.append(Open(index: result.count, id: "browser:\(raw)"))
                    open = cards.count - 1
                    result.append(row)
                }
                if mark.op == "aborted" {
                    cards[open!].cancelled = true
                } else if mark.op == "plan" {
                    cards[open!].plans.append(mark.arguments)
                } else if case .tool(let step) = row.kind {
                    cards[open!].steps.append((step, mark))
                }
                continue
            }
            switch row.kind {
            case .user, .other, .handoff, .notice, .report:
                if let index = open {
                    cards[index].closed = true
                    if case .user(let body, _) = row.kind, body.trimmingCharacters(in: .whitespacesAndNewlines) == browserCancelText {
                        cards[index].cancelled = true
                    }
                }
                open = nil
            default: break
            }
            result.append(row)
        }
        for (position, card) in cards.enumerated() {
            let newest = position == cards.count - 1
            let task = browserTask(
                id: card.id,
                steps: card.steps,
                plans: card.plans,
                last: running && newest,
                context: context,
                // 人还没回话、这一轮也停了：交给人的话就是在等人接手。
                awaiting: !running && newest && !card.closed,
                cancelled: card.cancelled
            )
            result[card.index] = ChatRow(id: card.id, kind: .browser(task), gap: result[card.index].gap)
        }
        return result
    }

    /// 人在卡片或放大视图里点了「取消任务」、这一轮已经停着时，替人发的这句话。和 messages.ts 的 BROWSER_CANCEL_TEXT 一样。
    static let browserCancelText = "不用继续了，取消这个浏览器任务。"
    /// 计划里还没勾的一步是这类，就算交给人了。和 chat-rows.ts 的 HANDOVER_STEP 一样。
    private static let handoverWords = ["登录", "登入", "验证码", "扫码", "接手", "交给你", "等你"]

    private static func browserTask(id: String, steps: [(ToolStep, BrowserMark)], plans: [JSON], last: Bool, context: ChatContext, awaiting: Bool = false, cancelled: Bool = false) -> BrowserTask {
        let plan = plans.last
        let planSteps: [BrowserTask.PlanStep] = plan?["steps"]?.array?.compactMap { item in
            guard let text = item["text"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
            return BrowserTask.PlanStep(text: text, done: item["done"]?.bool == true)
        } ?? []
        let resultText = plan?["result"]?.string.flatMap { $0.isBlank ? nil : $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        let computerName = steps.lazy.compactMap { $0.0.computer }.first
        let computer = context.computers.first { $0.name == computerName || $0.id == computerName }
        let latest = steps.last
        let waiting = steps.first { $0.0.status == .waiting }
        // 交给人了：调过 browser_show，或者计划里还没勾的一步是「等你登录」这类。
        let handedOver = steps.contains { $0.1.op == "show" && $0.0.status == .done }
            || planSteps.contains { step in !step.done && handoverWords.contains { step.text.contains($0) } }
        let interrupted = latest.map { [.unfinished, .denied, .expired].contains($0.0.status) } ?? false
        let state: BrowserTask.State
        let status: String
        if resultText != nil {
            (state, status) = (.done, "做完了")
        } else if let waiting {
            let title = waiting.0.title.replacingOccurrences(of: #"^在「[^」]*」上|^在电脑上"#, with: "", options: .regularExpression)
            (state, status) = (.waiting, "等你批准：\(title)")
        } else if last {
            (state, status) = (.live, latest.map { browserDoing($0.1) } ?? "正在想怎么做")
        } else if cancelled || interrupted {
            // 「已停下」只给真取消了、真中断了的。
            (state, status) = (.stopped, "已停下")
        } else if latest?.0.status == .failed {
            (state, status) = (.failed, "没做完，最后一步出错了")
        } else if handedOver {
            // 人还没回话就是在等人接手；回过话了（说好了，或者接手完自动叫醒了），接着做的另起一张卡。
            (state, status) = awaiting ? (.handover, "等你接手") : (.stopped, "交给你接手了")
        } else if latest == nil || planSteps.contains(where: { !$0.done }) {
            // 这一轮自己停在半路（多半是在问人），不是取消。
            (state, status) = (.stopped, "等你回话")
        } else {
            (state, status) = (.done, "做完了")
        }
        return BrowserTask(
            id: id,
            computerId: computer?.id,
            computer: computer?.name ?? computerName,
            state: state,
            status: status,
            plan: planSteps,
            result: resultText,
            steps: steps.map(\.0)
        )
    }

    /// 卡片下面那一行：正在做的这一步，说成人话。
    static func browserDoing(_ mark: BrowserMark) -> String {
        func text(_ key: String) -> String { mark.arguments[key]?.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "" }
        func clip(_ value: String) -> String { value.count > 60 ? String(value.prefix(60)) + "…" : value }
        switch mark.op {
        case "open":
            let raw = text("url")
            let host = URLComponents(string: raw).flatMap { components in
                components.host.map { host in components.port.map { "\(host):\($0)" } ?? host }
            } ?? raw
            return "正在浏览 \(clip(host))"
        case "look", "read": return "正在阅读页面"
        case "click": return text("label").isEmpty ? "正在点页面上的按钮" : "正在点「\(clip(text("label")))」"
        case "type": return "正在填写"
        case "key": return "正在按键"
        case "scroll": return "正在翻看页面"
        case "back": return "正在回到上一页"
        case "show": return "等你在电脑上的 Pupu 里接手"
        case "download": return "正在下载文件"
        default: return "正在用浏览器"
        }
    }

    /// 把电脑上的几步合成卡片：卡片放在第一步的位置，后面同一台电脑上的步骤收进去，中间说的话照常显示。
    /// 用户发了新消息、项目报回结果、系统通知、浏览器任务，或者换了一台电脑，就另起一张。
    /// 每一步收在卡片里：电脑卡展开后列出每一步，工具卡片一步时直接带输出、几步时点开看。和网页的 chat-rows.ts 一起改。
    private static func computerCards(_ rows: [ChatRow], running: Bool, context: ChatContext) -> [ChatRow] {
        struct Open {
            let index: Int
            let id: String
            let computer: String?
            var steps: [ToolStep] = []
        }
        var result: [ChatRow] = []
        var cards: [Open] = []
        var open: Int?
        for row in rows {
            switch row.kind {
            case .tool(let step):
                if open == nil || cards[open!].computer != step.computer {
                    cards.append(Open(index: result.count, id: "computer:\(step.callId)", computer: step.computer))
                    open = cards.count - 1
                    result.append(row)
                }
                cards[open!].steps.append(step)
                continue
            case .user, .other, .handoff, .notice, .report, .browser, .time:
                open = nil
            default:
                break
            }
            result.append(row)
        }
        for (position, card) in cards.enumerated() {
            let task = computerTask(card.id, steps: card.steps, context: context, live: running && position == cards.count - 1)
            result[card.index] = ChatRow(id: card.id, kind: .computer(task), gap: result[card.index].gap)
        }
        return result
    }

    private static func computerTask(_ id: String, steps: [ToolStep], context: ChatContext, live: Bool) -> ComputerTask {
        let name = steps.first?.computer
        let computer = context.computers.first { $0.name == name || $0.id == name }
        let latest = steps.last
        let usesScreen = steps.contains(where: \.screen)
        let state: ComputerTask.State
        if steps.contains(where: { $0.status == .waiting }) {
            state = .waiting
        } else if steps.contains(where: { $0.status == .running }) || (live && latest?.status == .done) {
            state = .live
        } else if latest?.status == .failed {
            state = .failed
        } else if let latest, latest.status != .done {
            state = .stopped
        } else {
            state = .done
        }
        let failures = steps.filter { $0.status == .failed }.count
        let status: String = if usesScreen {
            switch state {
            case .waiting: "等你批准"
            case .live: "正在用"
            case .failed: "出错了"
            case .stopped: "已停下"
            case .done: "用完了"
            }
        } else if state == .waiting {
            "等你批准"
        } else if state == .live {
            "正在做"
        } else if failures > 0 {
            failures > 1 || steps.count > 1 ? "\(failures) 件没成" : "失败"
        } else if state == .stopped {
            "没做完"
        } else {
            ""
        }
        return ComputerTask(
            id: id,
            computerId: computer?.id,
            computer: computer?.name ?? name,
            state: state,
            status: status,
            usesScreen: usesScreen,
            latest: latest.map(stepText) ?? "",
            steps: steps,
            screen: steps.last { $0.image != nil }?.image,
            expanded: (state == .failed) != context.toggled.contains(id)
        )
    }

    /// 连着派出去的几件事合成一块：第一件的位置放整块，后面的去掉。
    private static func taskLists(_ rows: [ChatRow]) -> [ChatRow] {
        var result: [ChatRow] = []
        for row in rows {
            guard case .task(let task) = row.kind else {
                result.append(row)
                continue
            }
            if let last = result.last, case .tasks(let tasks) = last.kind {
                result[result.count - 1].kind = .tasks(tasks + [task])
            } else {
                result.append(ChatRow(id: row.id, kind: .tasks([task]), gap: row.gap))
            }
        }
        return result
    }

    /// 时间分隔线上的字：「今天 14:02」「昨天 09:15」「11月12日 14:02」，不是今年的带年份。和网页 chat-rows.ts 的 dividerTime 一样。
    static func dividerTime(_ at: Double, now: Date = .now, calendar: Calendar = .current) -> String {
        let date = Date(timeIntervalSince1970: at / 1000)
        let clock = clockTime(at, calendar: calendar)
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        if days == 0 { return "今天 \(clock)" }
        if days == 1 { return "昨天 \(clock)" }
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        let day = "\(parts.month ?? 0)月\(parts.day ?? 0)日"
        return parts.year == calendar.component(.year, from: now) ? "\(day) \(clock)" : "\(parts.year ?? 0)年\(day) \(clock)"
    }

    /// 几点几分：「14:03」。
    static func clockTime(_ at: Double, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.hour, .minute], from: Date(timeIntervalSince1970: at / 1000))
        return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    }

    /// 一步的标题去掉开头的「在「mbpro」上」，卡片上已经写了是哪台电脑。
    static func stepText(_ step: ToolStep) -> String {
        if let range = step.title.range(of: #"^(在「[^」]*」上|在电脑上)"#, options: .regularExpression) {
            return String(step.title[range.upperBound...])
        }
        return step.title
    }
}

/// 电脑上的一步，画成「在「mbpro」上跑了 npm test」。
nonisolated struct ToolAction {
    let icon: String
    let verb: String
    /// 跟在动词后面；英文和路径前面带空格。
    let object: String

    init?(name: String, arguments: JSON) {
        func text(_ key: String) -> String { arguments[key]?.string ?? "" }
        func point(_ x: String, _ y: String) -> String {
            " (\(Self.number(arguments[x])), \(Self.number(arguments[y])))"
        }
        switch name {
        case "run_command": (icon, verb, object) = ("terminal", "跑", " " + Self.clip(text("command")))
        case "write_stdin": (icon, verb, object) = ("keyboard", "往命令里输入", "「\(Self.clip(text("data")))」")
        case "read_file": (icon, verb, object) = ("doc.text", "读", " " + text("path"))
        case "write_file": (icon, verb, object) = ("square.and.pencil", "写", " " + text("path"))
        case "list_directory":
            let path = text("path")
            (icon, verb, object) = ("folder", "看", path.isBlank ? "主目录" : " " + path)
        case "computer_screenshot", "computer_look": (icon, verb, object) = ("camera.viewfinder", "看", "窗口")
        case "computer_windows": (icon, verb, object) = ("macwindow.on.rectangle", "看", "开着的窗口")
        case "computer_open": (icon, verb, object) = ("macwindow", "打开", " " + text("app"))
        case "computer_click":
            let double = (arguments["count"]?.number ?? 1) >= 2
            let label = text("label")
            (icon, verb, object) = ("cursorarrow.click", double ? "双击" : "点", label.isBlank ? point("x", "y") : " " + label)
        case "computer_move": (icon, verb, object) = ("cursorarrow.motionlines", "把鼠标移到", point("x", "y"))
        case "computer_drag": (icon, verb, object) = ("hand.draw", "拖", point("x", "y") + " →" + point("x2", "y2"))
        case "computer_scroll": (icon, verb, object) = ("arrow.up.and.down", "滚动", "窗口")
        case "computer_type": (icon, verb, object) = ("character.cursor.ibeam", "输入", "「\(Self.clip(text("text")))」")
        case "computer_set": (icon, verb, object) = ("slider.horizontal.3", "改成", "「\(Self.clip(text("value")))」")
        case "computer_key": (icon, verb, object) = ("command", "按", " " + text("key"))
        case "computer_menu":
            let path = arguments["menu"]?.array?.compactMap(\.string).joined(separator: " → ") ?? ""
            (icon, verb, object) = ("filemenu.and.selection", "点菜单", " " + path)
        case "browser_open": (icon, verb, object) = ("safari", "在浏览器里打开", " " + Self.clip(text("url")))
        case "browser_look": (icon, verb, object) = ("eye", "看", "网页")
        case "browser_read": (icon, verb, object) = ("doc.text", "读", "网页")
        case "browser_click":
            let label = text("label")
            (icon, verb, object) = ("cursorarrow.click", "在网页上点", label.isBlank ? " 编号 \(Self.number(arguments["ref"]))" : " " + label)
        case "browser_type":
            let hidden = arguments["sensitive"]?.bool == true
            (icon, verb, object) = ("character.cursor.ibeam", "在网页上输入", hidden ? "敏感内容" : "「\(Self.clip(text("text")))」")
        case "browser_key": (icon, verb, object) = ("command", "在网页上按", " " + text("key"))
        case "browser_scroll": (icon, verb, object) = ("arrow.up.and.down", "滚动", "网页")
        case "browser_back": (icon, verb, object) = ("chevron.backward", "后退到", "上一页")
        case "browser_show": (icon, verb, object) = ("macwindow", "请人在电脑上接手", "")
        case "browser_download": (icon, verb, object) = ("arrow.down.circle", "下载", " " + Self.clip(text("url")))
        default: return nil
        }
    }

    private static func clip(_ text: String) -> String {
        let line = text.split(separator: "\n", omittingEmptySubsequences: true).first.map(String.init) ?? ""
        return line.count > 60 ? String(line.prefix(60)) + "…" : line
    }

    private static func number(_ value: JSON?) -> String {
        guard let value = value?.number else { return "?" }
        return value == value.rounded() ? String(Int(value)) : String(format: "%.1f", value)
    }
}

nonisolated extension String {
    var isBlank: Bool { trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
}
