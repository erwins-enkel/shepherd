import Foundation
import ShepherdKit
import Testing

@testable import ShepherdAppCore

extension CoreSeamTests {
struct ChatTimelineTests {
    private func user(_ text: String, ts: Int = 1000, steer: String? = nil, initial: Bool = false) -> AgentMessage {
        .init(role: .init(value1: .user), text: text, ts: ts, steer: steer, initial: initial)
    }
    private func entry(_ kind: ChatTimeline.Kind, _ ts: Int) -> ChatTimeline.Entry {
        .init(kind: kind, text: "text", ts: ts)
    }
    private func tool(_ ts: Int) -> ActivityEntry {
        .init(ts: ts, tool: "Bash", summary: "swift build", status: .init(known: .ok))
    }

    @Test func pasteWrappersAndUnknownSteers() {
        let wrapped = "\n<pasted_content id=\"a1\">\nline one\nline two\n</pasted_content id=\"a1\">\n"
        let entries = ChatTimeline.entries([user(wrapped), user(wrapped, steer: "future-steer")])
        #expect(entries.map(\.text) == ["line one\nline two", "line one\nline two"])
        #expect(entries.map(\.kind) == [.user, .steer])
        #expect(entries.last?.steer == "future-steer")
        #expect(ChatTimeline.unwrapPasted("<pasted_content id=\"a\">\nx\n</pasted_content>") == "x")
        let unmatched = "<pasted_content id=\"a\">\nx\n</pasted_content id=\"b\">"
        #expect(ChatTimeline.unwrapPasted(unmatched) == unmatched)
    }

    @Test func onlyInitialPromptsLoseWholeFenceLines() {
        let prompt = "Fix\n⟦UNTRUSTED:issue:ab12⟧\n## Problem\n⟦/UNTRUSTED:issue:ab12⟧"
        let entries = ChatTimeline.entries([user(prompt, initial: true), user(prompt)])
        #expect(entries.first?.text == "Fix\n## Problem")
        #expect(entries.first?.initial == true)
        #expect(entries.last?.text == prompt)
        #expect(ChatTimeline.stripFenceMarkers("a ⟦UNTRUSTED:x:1⟧ b\n⟦/UNTRUSTED:x:1⟧ \nc") == "a ⟦UNTRUSTED:x:1⟧ b\nc")
    }

    @Test func harnessTrafficCommandsAndEvents() {
        let entries = ChatTimeline.entries([
            user("<local-command-stdout>hidden</local-command-stdout>"),
            user("<system-reminder>hidden</system-reminder>"),
            user("<task-notification><summary>Background work finished</summary></task-notification>"),
            user("<task-notification><task-id>x</task-id></task-notification>"),
            user("<command-message>design</command-message><command-name>/design</command-name><command-args>B bitte</command-args>"),
            user("<command-name>/clear</command-name>"),
            user("<div>operator text"),
            .init(role: .init(value1: .assistant), text: "<system-reminder>agent prose</system-reminder>", ts: 1),
        ])
        #expect(entries.map(\.kind) == [.event, .user, .user, .user, .assistant])
        #expect(entries.map(\.text) == ["Background work finished", "/design B bitte", "/clear", "<div>operator text", "<system-reminder>agent prose</system-reminder>"])
    }

    @Test func toolRunsInterleaveAndEqualStampsFollowMessages() {
        let rows = ChatTimeline.rows([entry(.user, 10), entry(.assistant, 50)], tools: [tool(5), tool(20), tool(30), tool(60)])
        #expect(rows.map(\.kind) == [.tools, .user, .tools, .assistant, .tools])
        #expect(rows[2].calls.map(\.ts) == [20, 30])
        #expect(ChatTimeline.rows([entry(.assistant, 10)], tools: [tool(10)]).map(\.kind) == [.assistant, .tools])
        #expect(ChatTimeline.rows([entry(.user, 0), entry(.assistant, 40)], tools: [tool(20)]).map(\.kind) == [.user, .tools, .assistant])
    }

    @Test func keysSurviveAppendsAndDisambiguateSharedStamps() {
        let before = ChatTimeline.rows([entry(.user, 10)], tools: [tool(20)])
        let after = ChatTimeline.rows([entry(.user, 10), entry(.assistant, 40)], tools: [tool(20), tool(30)])
        #expect(before.map(\.id) == after.prefix(2).map(\.id))
        let same = ChatTimeline.rows([entry(.user, 1), entry(.user, 1)])
        #expect(Set(same.map(\.id)).count == 2)
    }

    @Test func ledgerAnchorsMinutesAndOperatorTurns() {
        let rows = ChatTimeline.rows([entry(.user, 60_000), entry(.assistant, 61_000), entry(.event, 62_000),
            entry(.steer, 63_000), entry(.assistant, 120_000), entry(.assistant, 0), entry(.user, 121_000)])
        let marks = ChatTimeline.ledger(rows, timeZone: TimeZone(secondsFromGMT: 0)!)
        #expect(marks.map(\.time) == ["00:01", nil, nil, "00:01", "00:02", nil, "00:02"])
        #expect(marks.map(\.turn) == [false, false, false, true, false, false, true])
    }

    @Test func echoesUseClockSkewAndStaySettledBeyondTheWindow() {
        let sent = ChatTimeline.Pending(text: "yes", at: 100_000)
        #expect(ChatTimeline.settle([sent], entries: [.init(kind: .user, text: "yes", ts: 30_000)]).first?.echoTS == nil)
        let settled = ChatTimeline.settle([sent], entries: [.init(kind: .steer, text: " yes ", ts: 95_000, steer: "go")])
        #expect(settled.first?.echoTS == 95_000)
        #expect(ChatTimeline.settle(settled, entries: []).first?.echoTS == 95_000)
    }

    @Test func repeatedSendsNeedSeparateTranscriptEchoes() {
        let sends = [ChatTimeline.Pending(text: "yes", at: 100_000), .init(text: "yes", at: 101_000)]
        let echo = ChatTimeline.Entry(kind: .user, text: "yes", ts: 101_000)
        let settled = ChatTimeline.settle(sends, entries: [echo])
        #expect(settled.filter { $0.echoTS != nil }.count == 1)
        #expect(ChatTimeline.settle(settled, entries: [echo]).filter { $0.echoTS != nil }.count == 1)
        #expect(ChatTimeline.settle(settled, entries: [echo, .init(kind: .user, text: "yes", ts: 102_000)]).allSatisfy { $0.echoTS != nil })
    }
}
}
