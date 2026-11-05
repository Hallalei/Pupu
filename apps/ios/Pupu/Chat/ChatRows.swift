import CoreGraphics
import Foundation

/// 聊天列表里的一行。一条 Pupu 的消息会拆成好几行：正文、项目标签、电脑上的操作。聊天里还有项目报回来的结果。
/// 思考过程不显示，跟聊天软件一样只看回复。
nonisolated struct ChatRow: Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        /// 我发的消息；quote 是开头引用的那段。
        case user(body: String, quote: String?)
        /// 别人发的消息。
        case other(body: String, quote: String?, sender: Sender)
        /// Pupu 的正文，Markdown。
        case assistant(String)
        /// Pupu 还没出字：一个只有三个点的气泡。
        case typing(retrying: Bool)
        case projectTag(name: String, projectId: String?)
        case tool(ToolStep)
        case toolGroup(ToolGroup)
        case notice(String)
        /// 项目会话里，从聊天转来的事。
        case handoff(String)
        /// 聊天里，项目报回来的结果。
        case report(ReportCard)
        case error(String)
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
}

/// 连着好几步，合成一组。
nonisolated struct ToolGroup: Equatable, Sendable {
    let title: String
    let status: ToolStep.Status
    let failures: Int
    var expanded: Bool
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
    /// 连着这么多步就合成一组。
    static let groupMinimum = 3

    private struct Result {
        let text: String
        let details: JSON?
        let error: Bool
    }

    static func build(_ view: SessionView, context: ChatContext) -> [ChatRow] {
        var results: [String: Result] = [:]
        for message in view.messages where message.role == .tool {
            for case let .toolResult(id, _, text, details, error) in message.parts {
                results[id] = Result(text: text, details: details, error: error)
            }
        }
        let outputs = Dictionary(view.tools.map { ($0.callId, $0.output) }, uniquingKeysWith: { _, last in last })

        var messages = view.messages.filter(isVisible)
        if let live = view.live, isVisible(live) { messages.append(live) }
        let retried = retriedFailures(messages, running: view.running)

        var reports = context.reports[...]
        var rows: [ChatRow] = []
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
                } else {
                    let split = SpecialMessage.splitQuote(text)
                    let kind: ChatRow.Kind = if let sender = otherSender(message, context: context) {
                        .other(body: split.body, quote: split.quote, sender: sender)
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
                    case .toolCall(let callId, let name, let arguments):
                        if let row = toolRow(
                            callId: callId,
                            name: name,
                            arguments: arguments,
                            result: results[callId],
                            output: outputs[callId],
                            running: view.running,
                            context: context
                        ) {
                            own.append(row)
                        }
                    default:
                        break
                    }
                }
                if let error = message.error, !error.isBlank {
                    own.append(ChatRow(id: "\(message.id)#error", kind: .error(modelErrorText(error))))
                }
            case .tool:
                break
            }
            for index in own.indices { own[index].gap = index == 0 ? 12 : 8 }
            rows += own
        }
        rows += reports.map(reportRow)
        rows = grouped(rows, context: context)
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
        context: ChatContext
    ) -> ChatRow? {
        switch name {
        case "create_project":
            guard context.projectTags, let projectName = arguments["name"]?.string, !projectName.isBlank else { return nil }
            let project = context.projects.first { $0.name == projectName }
            return ChatRow(id: "tag:\(callId)", kind: .projectTag(name: projectName, projectId: project?.id))
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

            let status: ToolStep.Status
            if let result {
                // 没批准的一步，桥回给模型的话里写着「没有执行」。
                if result.text.contains("没有执行：") {
                    status = result.text.contains("作废") ? .expired : .denied
                } else {
                    status = result.error ? .failed : .done
                }
            } else if running {
                let waiting = context.approvals.contains { approval in
                    computer.map { approval.computerId == $0.id } ?? true
                }
                status = waiting ? .waiting : .running
            } else {
                status = .unfinished
            }

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
                expanded: (status == .failed) != context.toggled.contains(id)
            )))
        }
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
        if status == .denied || status == .expired, let cut = result.range(of: "，没有执行：") {
            return String(result[..<cut.lowerBound]) + "，这一步没有做。"
        }
        return result
    }

    /// 连着的几步合成一组，点开再看每一步。
    private static func grouped(_ rows: [ChatRow], context: ChatContext) -> [ChatRow] {
        var result: [ChatRow] = []
        var run: [ChatRow] = []

        func flush() {
            defer { run = [] }
            let steps = run.compactMap { row -> ToolStep? in
                if case .tool(let step) = row.kind { return step }
                return nil
            }
            guard steps.count >= groupMinimum else {
                result += run
                return
            }
            let id = "group:\(steps[0].callId)"
            let expanded = context.toggled.contains(id)
            let names = Set(steps.compactMap(\.computer))
            let place = names.count == 1 ? "在「\(names.first!)」上" : "在电脑上"
            let failures = steps.filter { [.failed, .denied, .expired].contains($0.status) }.count
            let status: ToolStep.Status =
                if steps.contains(where: { $0.status == .waiting }) { .waiting }
                else if steps.contains(where: { $0.status == .running }) { .running }
                else if failures > 0 { .failed }
                else if steps.contains(where: { $0.status == .unfinished }) { .unfinished }
                else { .done }
            let group = ToolGroup(title: "\(place)做了 \(steps.count) 件事", status: status, failures: failures, expanded: expanded)
            result.append(ChatRow(id: id, kind: .toolGroup(group), gap: run[0].gap))
            if expanded {
                result += run.map { row in
                    var row = row
                    row.gap = 8
                    return row
                }
            }
        }

        for row in rows {
            if case .tool = row.kind {
                run.append(row)
            } else {
                flush()
                result.append(row)
            }
        }
        flush()
        return result
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
        case "computer_screenshot": (icon, verb, object) = ("camera.viewfinder", "截", "屏")
        case "computer_click":
            let double = (arguments["count"]?.number ?? 1) >= 2
            (icon, verb, object) = ("cursorarrow.click", double ? "双击" : "点", point("x", "y"))
        case "computer_move": (icon, verb, object) = ("cursorarrow.motionlines", "把鼠标移到", point("x", "y"))
        case "computer_drag": (icon, verb, object) = ("hand.draw", "拖", point("x", "y") + " →" + point("x2", "y2"))
        case "computer_scroll": (icon, verb, object) = ("arrow.up.and.down", "滚动", "屏幕")
        case "computer_type": (icon, verb, object) = ("character.cursor.ibeam", "输入", "「\(Self.clip(text("text")))」")
        case "computer_key": (icon, verb, object) = ("command", "按", " " + text("key"))
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
