import Foundation
import ShepherdKit

/// Pure mobile Chat projection. Mirrors assistant-chat.ts and chat-timeline.ts;
/// it never changes the transcript or the terminal's presentation.
public enum ChatTimeline {
    public enum Kind: String, Sendable { case assistant, user, steer, event, tools }

    public struct Entry: Equatable, Sendable {
        public let kind: Kind
        public let text: String
        public let ts: Int
        public let steer: String?
        public let initial: Bool

        public init(kind: Kind, text: String, ts: Int, steer: String? = nil, initial: Bool = false) {
            self.kind = kind; self.text = text; self.ts = ts; self.steer = steer; self.initial = initial
        }
    }

    public struct Row: Identifiable, Equatable, Sendable {
        public let id: String
        public let kind: Kind
        public let ts: Int
        public let entry: Entry?
        public var calls: [ActivityEntry]
    }

    public struct Mark: Equatable, Sendable {
        public let time: String?
        public let turn: Bool
    }

    public struct Pending: Identifiable, Equatable, Sendable {
        public let id: UUID
        public let text: String
        public let at: Int
        public var echoTS: Int?
        public init(text: String, at: Int) {
            id = UUID(); self.text = text; self.at = at
        }
    }

    private static let harnessTags: Set<String> = [
        "task-notification", "command-name", "command-message", "command-args",
        "local-command-stdout", "local-command-stderr", "local-command-caveat",
        "bash-input", "bash-stdout", "bash-stderr", "system-reminder", "user-prompt-submit-hook",
    ]

    public static func unwrapPasted(_ text: String) -> String {
        replace(text, pattern: #"<pasted_content id="([^"]*)">\n?([\s\S]*?)\n?</pasted_content(?: id="\1")?>"#, template: "$2").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public static func stripFenceMarkers(_ text: String) -> String {
        replace(text, pattern: #"(?m)^⟦/?UNTRUSTED:[^⟧⟦\n]*⟧[ \t]*(?:\n|$)"#, template: "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public static func entries(_ messages: [AgentMessage]) -> [Entry] {
        messages.compactMap { message in
            if message.role.value1 == .assistant || message.role.value2 == "assistant" {
                return Entry(kind: .assistant, text: message.text, ts: message.ts)
            }
            let body = unwrapPasted(message.text)
            if let steer = message.steer, !steer.isEmpty {
                return Entry(kind: .steer, text: body, ts: message.ts, steer: steer)
            }
            let tag = capture(body, pattern: #"^<([a-z][a-z0-9-]*)>"#)
            guard let tag, harnessTags.contains(tag) else {
                return Entry(kind: .user, text: message.initial == true ? stripFenceMarkers(body) : body,
                    ts: message.ts, initial: message.initial == true)
            }
            if let command = tagText(body, "command-name"), !command.isEmpty {
                let args = tagText(body, "command-args") ?? ""
                return Entry(kind: .user, text: args.isEmpty ? command : "\(command) \(args)", ts: message.ts)
            }
            if tag == "task-notification", let summary = tagText(body, "summary"), !summary.isEmpty {
                return Entry(kind: .event, text: summary, ts: message.ts)
            }
            return nil
        }
    }

    /// Tool input is already oldest first. Equal stamps put the message first;
    /// unstamped messages keep their transcript position. IDs survive appends.
    public static func rows(_ entries: [Entry], tools: [ActivityEntry] = []) -> [Row] {
        var result: [Row] = []
        var seen: [String: Int] = [:]
        var t = 0
        func key(_ base: String) -> String {
            let n = seen[base, default: 0]; seen[base] = n + 1
            return "\(base):\(n)"
        }
        func push(_ call: ActivityEntry) {
            if result.last?.kind == .tools { result[result.count - 1].calls.append(call) }
            else { result.append(Row(id: key("tools:\(call.ts)"), kind: .tools, ts: call.ts, entry: nil, calls: [call])) }
        }
        for entry in entries {
            while entry.ts > 0 && t < tools.count && tools[t].ts < entry.ts { push(tools[t]); t += 1 }
            result.append(Row(id: key("\(entry.kind.rawValue):\(entry.ts)"), kind: entry.kind, ts: entry.ts, entry: entry, calls: []))
        }
        while t < tools.count { push(tools[t]); t += 1 }
        return result
    }

    public static func ledger(_ rows: [Row], timeZone: TimeZone = .current) -> [Mark] {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_GB")
        formatter.timeZone = timeZone
        formatter.dateFormat = "HH:mm"
        var shown: String?
        return rows.enumerated().map { index, row in
            let turn = index > 0 && (row.kind == .user || row.kind == .steer)
            let label = row.ts > 0 ? formatter.string(from: Date(timeIntervalSince1970: Double(row.ts) / 1000)) : nil
            let time = label != nil && (turn || label != shown) ? label : nil
            if let time { shown = time }
            return Mark(time: time, turn: turn)
        }
    }

    /// One transcript row settles one send, with the web's one-minute clock-skew
    /// allowance. Settled sends stay settled when their echo leaves the 50-row window.
    public static func settle(_ pending: [Pending], entries: [Entry]) -> [Pending] {
        var used: Set<Int> = []
        return pending.map { send in
            var send = send
            if let index = entries.indices.first(where: { index in
                let e = entries[index]
                return !used.contains(index) && (e.kind == .user || e.kind == .steer)
                    && e.text.trimmingCharacters(in: .whitespacesAndNewlines) == send.text.trimmingCharacters(in: .whitespacesAndNewlines)
                    && (send.echoTS.map { e.ts == $0 } ?? (e.ts >= send.at - 60_000))
            }) {
                used.insert(index)
                if send.echoTS == nil { send.echoTS = entries[index].ts }
            }
            return send
        }
    }

    private static func replace(_ text: String, pattern: String, template: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return text }
        return regex.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
    }
    private static func capture(_ text: String, pattern: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let range = Range(match.range(at: 1), in: text) else { return nil }
        return String(text[range])
    }
    private static func tagText(_ text: String, _ tag: String) -> String? {
        capture(text, pattern: "<\(tag)>([\\s\\S]*?)</\(tag)>")?.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
