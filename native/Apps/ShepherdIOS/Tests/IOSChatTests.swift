import Foundation
import SwiftUI
import XCTest
@testable import ShepherdAppCore
import ShepherdKit
@testable import ShepherdIOS

@MainActor
final class IOSChatTests: XCTestCase {
    private let empty = SessionMessages(messages: [], awaitingInput: false, pendingQuestion: nil)
    private struct Failure: Error {}

    func testPollUsesWorkingAndRestingCadenceAndStopsWhenNotCurrent() async {
        for running in [true, false] {
            let model = IOSChatModel()
            var current = true
            var reads = 0
            var delays: [Int] = []
            await model.poll(fetch: { reads += 1; return self.empty }, running: { running }, isCurrent: { current },
                wait: { seconds in delays.append(seconds); current = false })
            XCTAssertEqual(reads, 1)
            XCTAssertEqual(delays, [running ? 2 : 8])
            XCTAssertNotNil(model.data)
            await model.poll(fetch: { reads += 1; return self.empty }, running: { running }, isCurrent: { false })
            XCTAssertEqual(reads, 1)
        }
    }

    func testLateSelectionAndCancelledResponsesAreDiscarded() async {
        let model = IOSChatModel()
        var current = true
        await model.poll(fetch: { current = false; return self.empty }, running: { true }, isCurrent: { current })
        XCTAssertNil(model.data)

        var response: CheckedContinuation<SessionMessages, Never>?
        let task = Task {
            await model.poll(fetch: { await withCheckedContinuation { response = $0 } }, running: { true }, isCurrent: { true })
        }
        await until { response != nil }
        task.cancel()
        response?.resume(returning: empty)
        await task.value
        XCTAssertNil(model.data)
        XCTAssertFalse(model.loadFailed)
    }

    func testPollingRecoversFromFailureAndRetainsPreviousConversation() async {
        let model = IOSChatModel()
        var current = true
        var reads = 0
        await model.poll(fetch: {
            reads += 1
            if reads == 1 { throw Failure() }
            return self.empty
        }, running: { false }, isCurrent: { current }, wait: { _ in
            if reads == 1 { XCTAssertTrue(model.loadFailed) }
            else { current = false }
        })
        XCTAssertEqual(reads, 2)
        XCTAssertFalse(model.loadFailed)
        XCTAssertNotNil(model.data)
        current = true
        await model.poll(fetch: { throw Failure() }, running: { false }, isCurrent: { current }, wait: { _ in current = false })
        XCTAssertTrue(model.loadFailed)
        XCTAssertNotNil(model.data)
    }

    func testFailedSendKeepsDraftAndSuccessEchoSettlesPermanently() async {
        let model = IOSChatModel()
        model.draft = "  Bitte prüfen\nund testen  "
        await model.send(isCurrent: { true }, reply: { _ in throw Failure() })
        XCTAssertEqual(model.draft, "  Bitte prüfen\nund testen  ")
        XCTAssertTrue(model.sendFailed)
        XCTAssertFalse(model.sending)
        XCTAssertTrue(model.pending.isEmpty)
        var sent: [String] = []
        await model.send(isCurrent: { true }, reply: { sent.append($0) }, now: { 100_000 })
        XCTAssertEqual(sent, ["Bitte prüfen\nund testen"])
        XCTAssertEqual(model.waiting.count, 1)
        XCTAssertEqual(model.draft, "")
        XCTAssertFalse(model.sendFailed)
        var current = true
        await model.poll(fetch: {
            .init(messages: [.init(role: .init(value1: .user), text: "<pasted_content id=\"a\">\nBitte prüfen\nund testen\n</pasted_content>", ts: 101_000)],
                awaitingInput: false, pendingQuestion: nil)
        }, running: { false }, isCurrent: { current }, wait: { _ in current = false })
        XCTAssertTrue(model.waiting.isEmpty)
        current = true
        await model.poll(fetch: { self.empty }, running: { false }, isCurrent: { current }, wait: { _ in current = false })
        XCTAssertTrue(model.waiting.isEmpty)
    }

    func testSendingLocksComposerAndReadOnlyNeverReplies() async {
        let model = IOSChatModel()
        model.draft = "go"
        var replies = 0
        await model.send(isCurrent: { false }, reply: { _ in replies += 1 })
        XCTAssertEqual(replies, 0)
        var response: CheckedContinuation<Void, Never>?
        let task = Task {
            await model.send(isCurrent: { true }, reply: { _ in
                replies += 1
                await withCheckedContinuation { response = $0 }
            })
        }
        await until { model.sending && response != nil }
        XCTAssertFalse(model.canSend)
        await model.send(isCurrent: { true }, reply: { _ in replies += 1 })
        XCTAssertEqual(replies, 1)
        response?.resume()
        await task.value
        XCTAssertFalse(model.sending)
    }

    func testChatIsFirstDefaultAndMarkdownKeepsBlockStructure() {
        XCTAssertEqual(IOSSessionDetailTab.allCases.first, .chat)
        let session = PreviewData.session()
        let terminal = IOSTerminalPresentation(session: TerminalSessionModel(sessionID: session.id, reply: { _ in },
            makeAttachment: { _, _ in fatalError("Chat must not attach a PTY") }), reply: { _ in })
        let detail = IOSSessionDetailContent(session: session, model: DetailModel(loaders: .stubbed()), terminal: terminal,
            allowsInput: false, fontSize: .constant(12), surface: EmptyView())
        XCTAssertEqual(detail.tab, .chat)
        let blocks = IOSPlanMarkdownView.blocks("## Ergebnis\n\nAlles **bereit**.\n\n- Erst `swift build`\n- Dann testen")
        XCTAssertTrue(blocks.contains { $0.heading })
        XCTAssertEqual(blocks.filter { $0.marker == "•" }.count, 2)
        XCTAssertGreaterThanOrEqual(blocks.count, 4)
    }

    func testRenderChatFixture() throws {
        let model = IOSChatModel()
        model.data = .init(messages: [
            .init(role: .init(value1: .user), text: "Bitte zeig mir den Stand und die nächsten Schritte.", ts: 60_000),
            .init(role: .init(value1: .user), text: "Prüfe den Build vor dem nächsten Schritt.", ts: 70_000, steer: "review"),
            .init(role: .init(value1: .assistant), text: "## Chat ist bereit\n\nDie Unterhaltung ist jetzt **lesbar** und bleibt aktuell.\n\n- Markdown mit Überschriften und Listen\n- Tool-Aufrufe sind zusammengefasst\n- Mit `swift test` geprüft\n\nDu kannst unten schreiben oder die Nachricht diktieren.", ts: 90_000),
            .init(role: .init(value1: .user), text: "<task-notification><summary>Build erfolgreich abgeschlossen</summary></task-notification>", ts: 91_000),
        ], awaitingInput: true, pendingQuestion: nil, tools: [
            .init(ts: 80_000, tool: "Read", summary: "SessionDetailView.swift", status: .init(known: .ok)),
            .init(ts: 81_000, tool: "Bash", summary: "swift test", status: .init(known: .ok)),
        ])
        let session = PreviewData.session(name: "Chat in der iOS-App", prompt: "Mobile Chat-Parität")
        let terminal = IOSTerminalPresentation(session: TerminalSessionModel(sessionID: session.id, reply: { _ in },
            makeAttachment: { _, _ in fatalError("Fixture has no PTY") }), reply: { _ in })
        let directory = URL(fileURLWithPath: "/private/tmp/claude-501/-Users-kai-osthoff-githubrepos--shepherd-worktrees-shepherd-chat-modus-ios-fehlt/19db759e-efd2-4960-a6a6-d7e619d88b27/scratchpad/renders")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let content = IOSSessionDetailContent(session: session, model: DetailModel(loaders: .stubbed()), terminal: terminal,
            allowsInput: true, fontSize: .constant(12), surface: EmptyView(), selectableText: false,
            chatSurface: AnyView(IOSChatContent(model: model, allowsInput: true, fixture: true)))
            .frame(width: 390, height: 844).preferredColorScheme(.dark)
        let renderer = ImageRenderer(content: content)
        renderer.scale = 2
        let png = try XCTUnwrap(renderer.uiImage?.pngData())
        try png.write(to: directory.appendingPathComponent("ios-session-chat.png"))
        XCTAssertGreaterThan(png.count, 10_000)
    }

    private func until(_ condition: () -> Bool) async {
        let deadline = ContinuousClock.now + .seconds(15)
        while !condition(), ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertTrue(condition())
    }
}
