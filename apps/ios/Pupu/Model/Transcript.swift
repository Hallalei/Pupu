import Foundation

// 移植自 apps/cloud/src/transcript.ts 和 src/view.ts（它们改编自 cloudflare/agents 的 pi 示例，MIT 协议）。
// 服务端发的是 pi 自己的事件，网页和 App 各自把它们折叠成界面状态，规则要和网页版保持一致。

nonisolated enum Part: Equatable, Sendable {
    case text(String)
    case thinking(String)
    case image
    case toolCall(id: String, name: String, arguments: JSON)
    case toolResult(id: String, name: String, text: String, details: JSON?, error: Bool)
}

/// 发这条消息的成员。名字是发的时候的名字，和云端 src/messages.ts 的 Sender 一样。
nonisolated struct Sender: Equatable, Sendable {
    let id: String
    let name: String
}

nonisolated struct Message: Equatable, Sendable {
    enum Role: String, Sendable {
        case user, assistant, tool, notice
    }

    /// pi 的 entry id；正在生成的那条是 `live`。
    let id: String
    let role: Role
    var parts: [Part]
    let timestamp: Double
    var stopReason: String?
    var error: String?
    /// 成员发的用户消息才有。早期的消息没有。
    var sender: Sender?

    var text: String {
        parts.map { part in
            if case .text(let text) = part { return text }
            return ""
        }.joined()
    }

    var hasText: Bool {
        parts.contains { part in
            if case .text(let text) = part { return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            return false
        }
    }
}

nonisolated enum Transcript {
    static let liveID = "live"
    /// 成员发的消息在 pi 里的 entry 种类，和云端 src/messages.ts 的 SENT_ENTRY 一样。
    static let sentEntry = "pupu.sent"

    static func project(message: JSON, id: String) -> Message {
        let timestamp = message["timestamp"]?.number ?? 0
        switch message["role"]?.string {
        case "user":
            return Message(id: id, role: .user, parts: userParts(message["content"]), timestamp: timestamp)
        case "assistant":
            return Message(
                id: id,
                role: .assistant,
                parts: (message["content"]?.array ?? []).compactMap(assistantPart),
                timestamp: timestamp,
                stopReason: message["stopReason"]?.string,
                error: message["errorMessage"]?.string
            )
        case "toolResult":
            let text = (message["content"]?.array ?? [])
                .compactMap { $0["type"]?.string == "text" ? $0["text"]?.string : nil }
                .joined(separator: "\n")
            let details = message["details"]
            return Message(
                id: id,
                role: .tool,
                parts: [
                    .toolResult(
                        id: message["toolCallId"]?.string ?? "",
                        name: message["toolName"]?.string ?? "",
                        text: text,
                        details: details,
                        error: message["isError"]?.bool ?? false
                    )
                ],
                timestamp: timestamp
            )
        default:
            // pi 把提示词的变化记成 system 消息，界面不显示。
            return Message(id: id, role: .notice, parts: [], timestamp: 0)
        }
    }

    /// 带模型消息的 entry 变成那条消息；重置变成一条提示；系统提示词这类记录没有对应的消息。
    static func project(entry: JSON) -> Message? {
        let id = entry["id"]?.idString ?? UUID().uuidString
        let kind = entry["kind"]?.string
        if kind == "pi.reset" {
            return Message(id: id, role: .notice, parts: [.text("上下文已重置")], timestamp: 0)
        }
        guard kind != "pi.system", let message = entry["model"]?[0] else { return nil }
        var projected = project(message: message, id: id)
        // 模型看到的正文带着名字，界面上显示原话。
        if kind == sentEntry, let data = entry["data"], let sender = data["sender"],
           let senderId = sender["id"]?.string, let name = sender["name"]?.string {
            projected.parts = userParts(data["input"])
            projected.sender = Sender(id: senderId, name: name)
        }
        return projected
    }

    static func project(entries: [JSON]) -> [Message] {
        entries.compactMap { project(entry: $0) }
    }

    static func assistantPart(_ block: JSON) -> Part? {
        switch block["type"]?.string {
        case "text": .text(block["text"]?.string ?? "")
        case "thinking": .thinking(block["thinking"]?.string ?? "")
        case "toolCall":
            .toolCall(
                id: block["id"]?.string ?? "",
                name: block["name"]?.string ?? "",
                arguments: block["arguments"] ?? .null
            )
        default: nil
        }
    }

    private static func userParts(_ content: JSON?) -> [Part] {
        if let text = content?.string { return [.text(text)] }
        return (content?.array ?? []).compactMap { part in
            switch part["type"]?.string {
            case "text": .text(part["text"]?.string ?? "")
            case "image": .image
            default: nil
            }
        }
    }
}

/// 正在跑的工具调用和它流出来的输出。
nonisolated struct RunningTool: Equatable, Sendable {
    let callId: String
    let name: String
    var output: String
}

/// 一个会话在界面上要显示的全部东西。
nonisolated struct SessionView: Equatable, Sendable {
    struct Retry: Equatable, Sendable {
        let at: Double
        let error: String
    }

    var messages: [Message] = []
    /// 正在生成的那条 Pupu 消息。
    var live: Message?
    var running = false
    var tools: [RunningTool] = []
    /// 排在当前这一轮后面的消息数。
    var queued = 0
    var retry: Retry?
    var error: String?
}

nonisolated enum Reducer {
    static func reduce(_ view: SessionView, events: [JSON]) -> SessionView {
        events.reduce(view, reduce)
    }

    static func reduce(_ view: SessionView, _ event: JSON) -> SessionView {
        var next = view
        switch event["type"]?.string {
        case "snapshot":
            let partial = event["generation"]?["message"]
            next.messages = Transcript.project(entries: event["entries"]?.array ?? [])
            next.live = partial.flatMap { $0.isNull ? nil : Transcript.project(message: $0, id: Transcript.liveID) }
            next.running = !(event["run"] ?? .null).isNull
            next.tools = (event["tools"]?.array ?? [])
                .filter { $0["status"]?.string == "running" }
                .map {
                    RunningTool(
                        callId: $0["callId"]?.string ?? "",
                        name: $0["name"]?.string ?? "",
                        output: $0["output"]?.string ?? ""
                    )
                }
            next.queued = event["inbox"]?.array?.count ?? 0
            next.retry = retry(event["generation"]?["retry"])
            next.error = nil
        case "run_start":
            next.running = true
            next.error = nil
        case "run_end":
            next.running = false
            next.live = nil
            next.tools = []
            next.retry = nil
        case "message_start":
            if let message = event["message"], message["role"]?.string == "assistant" {
                next.live = Transcript.project(message: message, id: Transcript.liveID)
            }
        case "message_update":
            next.live = apply(view.live, changes: event["changes"]?.array ?? [])
        case "message_end":
            if let entry = event["entry"] {
                next = append(next, entry: entry)
                if entry["model"]?[0]?["role"]?.string == "assistant" { next.live = nil }
            }
        case "entry_appended":
            if let entry = event["entry"] { next = append(next, entry: entry) }
        case "tool_execution_start":
            let callId = event["toolCallId"]?.string ?? ""
            next.tools.removeAll { $0.callId == callId }
            next.tools.append(RunningTool(callId: callId, name: event["toolName"]?.string ?? "", output: ""))
        case "tool_execution_update":
            guard let output = event["output"], !output.isNull else { break }
            let callId = event["toolCallId"]?.string ?? ""
            next.tools = next.tools.map { tool in
                guard tool.callId == callId else { return tool }
                var tool = tool
                if let set = output["set"]?.string {
                    tool.output = set
                } else {
                    let trim = Int(output["trimStart"]?.number ?? 0)
                    tool.output = String(tool.output.dropFirst(trim)) + (output["append"]?.string ?? "")
                }
                return tool
            }
        case "tool_execution_end":
            let callId = event["toolCallId"]?.string ?? ""
            next.tools.removeAll { $0.callId == callId }
        case "inbox_update":
            next.queued = event["items"]?.array?.count ?? 0
        case "auto_retry_start":
            next.retry = SessionView.Retry(at: event["at"]?.number ?? 0, error: event["errorMessage"]?.string ?? "")
        case "auto_retry_end":
            next.retry = nil
        case "task_failed":
            next.error = event["message"]?.string ?? "出错了"
        case "submission":
            let record = event["record"]
            let reason = record?["reason"]?.string ?? ""
            if record?["status"]?.string == "unanswered", reason != "aborted", reason != "withdrawn" {
                next.error = "这条消息没有得到回复：\(reason)"
            }
        default:
            break
        }
        return next
    }

    private static func retry(_ value: JSON?) -> SessionView.Retry? {
        guard let value, !value.isNull else { return nil }
        return SessionView.Retry(at: value["at"]?.number ?? 0, error: value["error"]?.string ?? "")
    }

    private static func append(_ view: SessionView, entry: JSON) -> SessionView {
        guard let message = Transcript.project(entry: entry) else { return view }
        var next = view
        // 重置之后是新的上下文，快照里也只有这之后的内容。
        if entry["kind"]?.string == "pi.reset" {
            next.messages = [message]
            return next
        }
        if next.messages.contains(where: { $0.id == message.id }) { return view }
        next.messages.append(message)
        return next
    }

    private static func apply(_ live: Message?, changes: [JSON]) -> Message? {
        var message = live
        for change in changes {
            let type = change["type"]?.string
            if type == "message", let full = change["message"] {
                message = Transcript.project(message: full, id: Transcript.liveID)
                continue
            }
            guard var current = message else { continue }
            let index = Int(change["contentIndex"]?.number ?? 0)
            while current.parts.count <= index { current.parts.append(.text("")) }
            switch type {
            case "text_start", "thinking_start", "toolcall_start", "block":
                if let block = change["block"], let part = Transcript.assistantPart(block) {
                    current.parts[index] = part
                }
            case "text_delta":
                var text = ""
                if case .text(let previous) = current.parts[index] { text = previous }
                current.parts[index] = .text(text + (change["delta"]?.string ?? ""))
            case "thinking_delta":
                var text = ""
                if case .thinking(let previous) = current.parts[index] { text = previous }
                current.parts[index] = .thinking(text + (change["delta"]?.string ?? ""))
            default:
                // toolcall_delta 是半截参数，等这个块完整了再画。
                break
            }
            message = current
        }
        return message
    }
}

/// 两种特殊的用户消息，和 apps/cloud/src/messages.ts 一致。
nonisolated enum SpecialMessage {
    static let handoffMark = "[[pupu:handoff]]"
    static let quoteLimit = 300

    /// 是聊天转来的事就返回要做的事。
    static func handoff(_ text: String) -> String? {
        guard text.hasPrefix(handoffMark) else { return nil }
        return String(text.dropFirst(handoffMark.count)).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func quoted(_ quote: String, reply: String) -> String {
        let clipped = quote.count > quoteLimit ? String(quote.prefix(quoteLimit)) + "…" : quote
        let block = clipped
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { "> \($0)" }
            .joined(separator: "\n")
        return "\(block)\n\n\(reply)"
    }

    /// 拆出开头的引用块。
    static func splitQuote(_ text: String) -> (quote: String?, body: String) {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        var index = 0
        while index < lines.count, lines[index].hasPrefix(">") { index += 1 }
        guard index > 0 else { return (nil, text) }
        let quote = lines[..<index]
            .map { line -> String in
                var line = String(line.dropFirst())
                if line.hasPrefix(" ") { line.removeFirst() }
                return line
            }
            .joined(separator: "\n")
        let body = lines[index...].joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return (quote, body)
    }
}
