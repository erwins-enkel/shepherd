import XCTest
import SwiftUI
import UIKit
import ShepherdKit
@testable import ShepherdAppCore
@testable import ShepherdIOS

@MainActor
private final class IOSFixturePTY: PTYAttaching {
    let output: AsyncStream<Data>
    let lifecycle: AsyncStream<PTYConnection.LifecycleEvent>
    private let outputSink: AsyncStream<Data>.Continuation
    private let lifecycleSink: AsyncStream<PTYConnection.LifecycleEvent>.Continuation
    private(set) var starts = 0
    private(set) var stops = 0
    private(set) var sizes: [(Int, Int)] = []
    private(set) var sent: [Data] = []
    init() {
        (output, outputSink) = AsyncStream.makeStream()
        (lifecycle, lifecycleSink) = AsyncStream.makeStream()
    }
    func start() { starts += 1 }
    func stop() { stops += 1 }
    func takeOver() {}
    func send(_ bytes: Data) { sent.append(bytes) }
    func resize(cols: Int, rows: Int) { sizes.append((cols, rows)) }
    func emit(_ event: PTYConnection.LifecycleEvent) { lifecycleSink.yield(event) }
    func emit(_ text: String) { outputSink.yield(Data(text.utf8)) }
}

@MainActor
final class IOSTerminalTests: XCTestCase {
    func testFontSettingsRendersFontLabelAndAccessibilityValue() throws {
        for points in [9.0, 12.0, 24.0] {
            let settings = IOSTerminalFontSettings(fontSize: .constant(points))
            let renderer = ImageRenderer(content: settings.frame(width: 300, height: 180))
            XCTAssertNotNil(renderer.uiImage, "Rendering evaluates both the label and slider accessibility value")
            XCTAssertEqual(L.t("native_ios_terminal_font_points", String(Int(points))), "\(Int(points)) pt")
        }
    }

    func testDismantleClosesDisplayLinkDetachesAndReleasesTerminal() async {
        let pty = IOSFixturePTY()
        let session = TerminalSessionModel(sessionID: "fixture", reply: { _ in }, makeAttachment: { _, _ in pty })
        let presentation = IOSTerminalPresentation(session: session, reply: { _ in })
        let coordinator = IOSTerminalHostView.Coordinator(model: presentation)
        weak var releasedView: IOSWatchingTerminalView?
        autoreleasepool {
            let view = IOSWatchingTerminalView(frame: CGRect(x: 0, y: 0, width: 390, height: 400),
                font: .monospacedSystemFont(ofSize: 12, weight: .regular))
            releasedView = view
            view.terminalDelegate = coordinator
            coordinator.bind(view)
            presentation.visibilityChanged(visible: true, active: true)
            IOSTerminalHostView.dismantleUIView(view, coordinator: coordinator)
            XCTAssertNil(view.terminalDelegate)
            XCTAssertNil(view.onUserScroll)
            XCTAssertNil(session.onOutput)
            XCTAssertNil(session.onClear)
            XCTAssertNil(presentation.scrollToTail)
            XCTAssertEqual(pty.stops, 1)
        }
        // UIKit can release its transient layout/display references on the next turn.
        await settle { releasedView == nil }
    }

    func testAttachmentRequiresActiveVisibleRendererAndClosesOnEveryExit() {
        var attachments: [IOSFixturePTY] = []
        let session = TerminalSessionModel(sessionID: "fixture", reply: { _ in }, makeAttachment: { _, _ in
            let pty = IOSFixturePTY(); attachments.append(pty); return pty
        })
        let presentation = IOSTerminalPresentation(session: session, reply: { _ in })
        var clears = 0
        session.onClear = { clears += 1 }
        presentation.visibilityChanged(visible: true, active: true)
        XCTAssertTrue(attachments.isEmpty)
        presentation.rendererMounted(cols: 50, rows: 20)
        XCTAssertEqual(attachments.count, 1)
        XCTAssertEqual(attachments[0].starts, 1)
        presentation.visibilityChanged(visible: true, active: true)
        XCTAssertEqual(attachments.count, 1)
        presentation.visibilityChanged(visible: true, active: false)
        XCTAssertEqual(attachments[0].stops, 1)
        presentation.visibilityChanged(visible: true, active: true)
        XCTAssertEqual(attachments.count, 2)
        XCTAssertEqual(clears, 2, "A fresh foreground replay clears the previous frame")
        presentation.visibilityChanged(visible: false, active: true)
        XCTAssertEqual(attachments[1].stops, 1)
        presentation.visibilityChanged(visible: false, active: false)
        XCTAssertEqual(attachments[1].stops, 1)
        presentation.rendererUnmounted()
        XCTAssertNil(session.onOutput)
        XCTAssertNil(session.onClear)
    }

    func testUnmountDetachesEvenBeforeSwiftUIDisappearsAndInactiveMountNeverAttaches() {
        let pty = IOSFixturePTY()
        let session = TerminalSessionModel(sessionID: "fixture", reply: { _ in }, makeAttachment: { _, _ in pty })
        let presentation = IOSTerminalPresentation(session: session, reply: { _ in })
        presentation.rendererMounted(cols: 50, rows: 20)
        presentation.visibilityChanged(visible: true, active: false)
        XCTAssertEqual(pty.starts, 0)
        presentation.visibilityChanged(visible: true, active: true)
        XCTAssertEqual(pty.starts, 1)
        presentation.rendererUnmounted()
        XCTAssertEqual(pty.stops, 1)
        XCTAssertFalse(presentation.isAttached)
        presentation.visibilityChanged(visible: false, active: false)
        XCTAssertEqual(pty.stops, 1)
    }

    func testTailFollowStopsForHistoryResumesAtBottomAndResetsOnReplay() {
        let session = TerminalSessionModel(sessionID: "fixture", reply: { _ in }, makeAttachment: { _, _ in IOSFixturePTY() })
        let presentation = IOSTerminalPresentation(session: session, reply: { _ in })
        XCTAssertTrue(presentation.followsTail)
        presentation.userScrolled(position: 0.4, canScroll: true)
        XCTAssertFalse(presentation.followsTail)
        presentation.userScrolled(position: 1, canScroll: true)
        XCTAssertTrue(presentation.followsTail)
        presentation.userScrolled(position: 0, canScroll: false)
        XCTAssertTrue(presentation.followsTail, "No scrollback is not a history position")
        presentation.userScrolled(position: 0.5, canScroll: true)
        var jumps = 0
        presentation.scrollToTail = { jumps += 1 }
        presentation.jumpToTail()
        XCTAssertEqual(jumps, 1)
        XCTAssertTrue(presentation.followsTail)
        presentation.userScrolled(position: 0.5, canScroll: true)
        presentation.replayWillBegin()
        XCTAssertTrue(presentation.followsTail)
    }

    func testGridResizesOnlyWhenAttachedAndOnlyWhenChanged() {
        let pty = IOSFixturePTY()
        let session = TerminalSessionModel(sessionID: "fixture", reply: { _ in }, makeAttachment: { cols, rows in
            XCTAssertEqual(cols, 60); XCTAssertEqual(rows, 22); return pty
        })
        let presentation = IOSTerminalPresentation(session: session, reply: { _ in })
        presentation.rendererMounted(cols: 50, rows: 20)
        presentation.resize(cols: 60, rows: 22)
        XCTAssertTrue(pty.sizes.isEmpty)
        presentation.visibilityChanged(visible: true, active: true)
        presentation.resize(cols: 80, rows: 24)
        presentation.resize(cols: 80, rows: 24)
        presentation.resize(cols: 0, rows: 24)
        XCTAssertEqual(pty.sizes.count, 1)
        XCTAssertEqual(pty.sizes[0].0, 80)
        presentation.rendererUnmounted()
    }

    func testRendererFeedsLiveBytesAndPreservesHistory() async {
        let pty = IOSFixturePTY()
        let session = TerminalSessionModel(sessionID: "fixture", reply: { _ in }, makeAttachment: { _, _ in pty })
        let presentation = IOSTerminalPresentation(session: session, reply: { _ in })
        let coordinator = IOSTerminalHostView.Coordinator(model: presentation)
        let view = IOSWatchingTerminalView(frame: CGRect(x: 0, y: 0, width: 390, height: 400),
            font: .monospacedSystemFont(ofSize: 12, weight: .regular))
        view.terminalDelegate = coordinator
        coordinator.bind(view)
        presentation.visibilityChanged(visible: true, active: true)
        pty.emit(.attached)
        pty.emit((0..<100).map { "fixture line \($0)\r\n" }.joined())
        await settle { view.canScroll && session.phase == .live }
        XCTAssertTrue(view.canScroll)
        view.scroll(toPosition: 0.3)
        presentation.userScrolled(position: view.scrollPosition, canScroll: view.canScroll)
        let oldRow = view.getTerminal().buffer.yDisp
        let feed = session.onOutput
        var received = false
        session.onOutput = { bytes in feed?(bytes); received = true }
        pty.emit("new output\r\n")
        await settle { received }
        XCTAssertFalse(presentation.followsTail)
        XCTAssertEqual(view.getTerminal().buffer.yDisp, oldRow)
        presentation.jumpToTail()
        XCTAssertEqual(view.scrollPosition, 1)
        XCTAssertTrue(view.accessibilityScroll(.up))
        XCTAssertFalse(presentation.followsTail)
        let voiceOverRow = view.getTerminal().buffer.yDisp
        received = false
        pty.emit("output during VoiceOver history reading\r\n")
        await settle { received }
        XCTAssertEqual(view.getTerminal().buffer.yDisp, voiceOverRow)
        presentation.jumpToTail()
        presentation.rendererUnmounted()
    }

    func testRendererClearsForegroundReplayAndOnlySendsEmulatorResponses() async {
        var attachments: [IOSFixturePTY] = []
        let core = TerminalSessionModel(sessionID: "fixture", reply: { _ in }, makeAttachment: { _, _ in
            let pty = IOSFixturePTY(); attachments.append(pty); return pty
        })
        let presentation = IOSTerminalPresentation(session: core, reply: { _ in })
        let coordinator = IOSTerminalHostView.Coordinator(model: presentation)
        let view = IOSWatchingTerminalView(frame: CGRect(x: 0, y: 0, width: 390, height: 400),
            font: .monospacedSystemFont(ofSize: 12, weight: .regular))
        view.terminalDelegate = coordinator
        coordinator.bind(view)
        presentation.visibilityChanged(visible: true, active: true)
        let replay = (0..<100).map { "line \($0)\r\n" }.joined()
        attachments[0].emit(replay)
        await settle { view.canScroll }
        let originalTail = view.getTerminal().buffer.yDisp
        coordinator.send(source: view, data: [3])
        XCTAssertTrue(attachments[0].sent.isEmpty, "Touch/selection output cannot interrupt the agent")
        presentation.visibilityChanged(visible: true, active: false)
        presentation.visibilityChanged(visible: true, active: true)
        XCTAssertEqual(attachments[0].stops, 1)
        XCTAssertFalse(view.canScroll, "Clear the previous frame before replay")
        attachments[1].emit(replay)
        await settle { view.canScroll }
        XCTAssertEqual(view.getTerminal().buffer.yDisp, originalTail, "Replay must not duplicate scrollback")
        attachments[1].emit("\u{1b}[c")
        await settle { !attachments[1].sent.isEmpty }
        presentation.rendererUnmounted()
    }

    func testReplyUsesKitRouteAndFailureKeepsDraft() async {
        let recorder = IOSReplyRecorder()
        let pty = IOSFixturePTY()
        let core = TerminalSessionModel(sessionID: "fixture", reply: { text in
            try await recorder.send(text)
        }, makeAttachment: { _, _ in pty })
        let presentation = IOSTerminalPresentation(session: core, reply: { text in try await recorder.send(text) })
        presentation.rendererMounted(cols: 50, rows: 20)
        presentation.visibilityChanged(visible: true, active: true)
        core.promptText = "   "
        XCTAssertFalse(presentation.canSubmitReply)
        core.promptText = "  Read the failing test\nthen fix it  "
        let connectingResult = await presentation.submitReply()
        XCTAssertFalse(connectingResult)
        XCTAssertTrue(recorder.texts.isEmpty)
        pty.emit(.attached)
        await settle { core.phase == .live }
        let result = await presentation.submitReply()
        XCTAssertTrue(result)
        XCTAssertEqual(recorder.texts, ["Read the failing test\nthen fix it"])
        XCTAssertEqual(core.promptText, "")
        recorder.fail = true
        core.promptText = "Preserve this draft"
        let failed = await presentation.submitReply()
        XCTAssertFalse(failed)
        XCTAssertEqual(core.promptText, "Preserve this draft")
        XCTAssertNotNil(presentation.replyError)
        XCTAssertFalse(presentation.replying)
        presentation.rendererUnmounted()
    }

    func testReplyCompletionCannotDismissSheetAfterBackgroundAndCannotOverlap() async {
        let gate = IOSReplyRecorder()
        gate.hold = true
        let pty = IOSFixturePTY()
        let session = TerminalSessionModel(sessionID: "fixture", reply: { text in
            try await gate.send(text)
        }, makeAttachment: { _, _ in pty })
        let presentation = IOSTerminalPresentation(session: session, reply: { text in try await gate.send(text) })
        presentation.rendererMounted(cols: 50, rows: 20)
        presentation.visibilityChanged(visible: true, active: true)
        pty.emit(.attached)
        await settle { session.phase == .live }
        session.promptText = "first message"
        let reply = Task { await presentation.submitReply() }
        await settle { gate.pending != nil }
        session.promptText = "next draft"
        XCTAssertFalse(presentation.canSubmitReply)
        presentation.visibilityChanged(visible: true, active: false)
        gate.pending?.resume()
        gate.pending = nil
        let completed = await reply.value
        XCTAssertFalse(completed)
        XCTAssertEqual(session.promptText, "next draft")
        XCTAssertEqual(gate.texts, ["first message"])
        presentation.rendererUnmounted()
    }

    func testFailedReplyRetainsDraftAndErrorAcrossSuspensionAndNavigation() async {
        for (navigatingAway, returnBeforeFailure) in [(false, false), (true, false), (false, true), (true, true)] {
            let gate = IOSReplyRecorder()
            gate.hold = true
            gate.fail = true
            var attachments: [IOSFixturePTY] = []
            let session = TerminalSessionModel(sessionID: "fixture", reply: { _ in
                XCTFail("iOS replies must not use the PTY generation's submitPrompt")
            }, makeAttachment: { _, _ in
                let pty = IOSFixturePTY(); attachments.append(pty); return pty
            })
            let presentation = IOSTerminalPresentation(session: session, reply: { text in try await gate.send(text) })
            presentation.rendererMounted(cols: 50, rows: 20)
            presentation.visibilityChanged(visible: true, active: true)
            attachments[0].emit(.attached)
            await settle { session.phase == .live }
            let draft = "  Keep this paragraph\nand its whitespace  "
            session.promptText = draft
            let reply = Task { await presentation.submitReply() }
            await settle { gate.pending != nil }
            XCTAssertEqual(session.promptText, draft)
            if navigatingAway {
                presentation.rendererUnmounted()
                presentation.visibilityChanged(visible: false, active: false)
            } else {
                presentation.visibilityChanged(visible: true, active: false)
            }
            XCTAssertTrue(presentation.replying)
            if returnBeforeFailure {
                presentation.rendererMounted(cols: 50, rows: 20)
                presentation.visibilityChanged(visible: true, active: true)
                attachments[1].emit(.attached)
                await settle { session.phase == .live }
            }
            XCTAssertFalse(presentation.canSubmitReply)
            gate.pending?.resume()
            gate.pending = nil
            let completed = await reply.value
            XCTAssertFalse(completed)
            XCTAssertEqual(session.promptText, draft)
            let error = presentation.replyError
            XCTAssertNotNil(error)
            XCTAssertFalse(presentation.replying)
            if !returnBeforeFailure {
                presentation.rendererMounted(cols: 50, rows: 20)
                presentation.visibilityChanged(visible: true, active: true)
                attachments[1].emit(.attached)
                await settle { session.phase == .live }
            }
            XCTAssertTrue(presentation.canSubmitReply)
            // A subsequent detach must also leave the recovered outcome intact.
            presentation.rendererUnmounted()
            XCTAssertEqual(presentation.replyError, error)
            XCTAssertEqual(session.promptText, draft)
        }
    }

    func testFailedReplyCannotOverwriteNewerDraft() async {
        let gate = IOSReplyRecorder()
        gate.hold = true
        gate.fail = true
        let pty = IOSFixturePTY()
        let session = TerminalSessionModel(sessionID: "fixture", reply: { _ in }, makeAttachment: { _, _ in pty })
        let presentation = IOSTerminalPresentation(session: session, reply: { text in try await gate.send(text) })
        presentation.rendererMounted(cols: 50, rows: 20)
        presentation.visibilityChanged(visible: true, active: true)
        pty.emit(.attached)
        await settle { session.phase == .live }
        session.promptText = "draft A"
        let reply = Task { await presentation.submitReply() }
        await settle { gate.pending != nil }
        // Even a programmatic edit while the UI is disabled must survive failure.
        session.promptText = "draft B"
        gate.pending?.resume()
        gate.pending = nil
        let completed = await reply.value
        XCTAssertFalse(completed)
        XCTAssertEqual(session.promptText, "draft B")
        XCTAssertEqual(gate.texts, ["draft A"])
        XCTAssertNotNil(presentation.replyError)
        presentation.rendererUnmounted()
    }

    func testReplyEditorIsDisabledWhileSending() async throws {
        let gate = IOSReplyRecorder()
        gate.hold = true
        let pty = IOSFixturePTY()
        let session = TerminalSessionModel(sessionID: "fixture", reply: { _ in }, makeAttachment: { _, _ in pty })
        let presentation = IOSTerminalPresentation(session: session, reply: { text in try await gate.send(text) })
        presentation.rendererMounted(cols: 50, rows: 20)
        presentation.visibilityChanged(visible: true, active: true)
        pty.emit(.attached)
        await settle { session.phase == .live }
        session.promptText = "draft A"
        let reply = Task { await presentation.submitReply() }
        await settle { gate.pending != nil }
        defer { gate.pending?.resume(); gate.pending = nil; presentation.rendererUnmounted() }
        let host = UIHostingController(rootView: IOSTerminalReplyBar(model: presentation))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 760))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil }
        host.view.layoutIfNeeded()
        func textView(in view: UIView) -> UIView? {
            if view is UITextView || view is UITextField { return view }
            return view.subviews.lazy.compactMap { textView(in: $0) }.first
        }
        let editor = try XCTUnwrap(textView(in: host.view))
        var acceptsInteraction = true
        var ancestor: UIView? = editor
        while let view = ancestor {
            acceptsInteraction = acceptsInteraction && view.isUserInteractionEnabled
            ancestor = view.superview
        }
        XCTAssertFalse(((editor as? UITextView)?.isEditable ?? (editor as? UITextField)?.isEnabled ?? false) && acceptsInteraction, "The in-flight draft cannot be edited")
        gate.pending?.resume()
        gate.pending = nil
        _ = await reply.value
    }

    func testControllerRetainsPresentationAcrossNavigationAndPrunesArchivedSessions() async throws {
        let launch = try IOSLaunchEnvironment(configuration: .init(isIsolated: true))
        let app = launch.makeModel()
        let store = try SessionStore(profile: ServerProfile(name: "fixture",
            baseURL: URL(string: "http://127.0.0.1:1")!, mode: .local), credentials: InMemoryCredentialStore())
        let fixture = PreviewData.session(name: "reply state")
        store.apply(.sessionNew(fixture))
        let controller = IOSTerminalController(store: store, app: app)
        defer { controller.teardown() }
        let first = controller.model(for: fixture.id)
        first.session.promptText = "saved draft"
        first.rendererUnmounted()
        for _ in 0..<20 { await Task.yield() }
        let returned = controller.model(for: fixture.id)
        XCTAssertTrue(first === returned)
        XCTAssertEqual(returned.session.promptText, "saved draft")
        store.apply(.sessionArchived(.init(id: fixture.id)))
        await settle { controller.model(for: fixture.id) !== first }
    }

    func testControllerRetainsSelectedDoneSessionUntilNavigationLeavesIt() async throws {
        let launch = try IOSLaunchEnvironment(configuration: .init(isIsolated: true))
        let app = launch.makeModel()
        let store = try SessionStore(profile: ServerProfile(name: "fixture",
            baseURL: URL(string: "http://127.0.0.1:1")!, mode: .local), credentials: InMemoryCredentialStore())
        let archived = PreviewData.session(id: "archived", name: "Done session")
        app.selectedSessionID = archived.id
        let controller = IOSTerminalController(store: store, app: app)
        defer { controller.teardown() }
        let first = controller.model(for: archived.id)
        first.session.promptText = "archived draft"
        for _ in 0..<20 { await Task.yield() }
        XCTAssertTrue(controller.model(for: archived.id) === first)
        // Unrelated live-list changes must not prune the selected Done detail.
        store.apply(.sessionNew(PreviewData.session(id: "live", name: "live session")))
        for _ in 0..<20 { await Task.yield() }
        XCTAssertTrue(controller.model(for: archived.id) === first)
        XCTAssertEqual(first.session.promptText, "archived draft")
        app.selectedSessionID = nil
        await settle { controller.model(for: archived.id) !== first }
    }

    func testKeyPaletteMatchesWebAndIsGatedByVisibilityAndIsolation() async {
        let expected: [IOSTerminalKey: [UInt8]] = [
            .escape: [27], .left: [27, 91, 68], .right: [27, 91, 67],
            .up: [27, 91, 65], .down: [27, 91, 66], .tab: [9], .space: [32],
            .ctrlA: [1], .ctrlE: [5], .ctrlU: [21], .ctrlC: [3], .ctrlD: [4], .enter: [13]
        ]
        let pty = IOSFixturePTY()
        let core = TerminalSessionModel(sessionID: "fixture", reply: { _ in }, makeAttachment: { _, _ in pty })
        let presentation = IOSTerminalPresentation(session: core, reply: { _ in })
        presentation.rendererMounted(cols: 50, rows: 20)
        presentation.visibilityChanged(visible: true, active: true)
        presentation.sendKey(.ctrlC)
        XCTAssertTrue(pty.sent.isEmpty)
        pty.emit(.attached)
        await settle { core.phase == .live }
        for key in IOSTerminalKey.allCases {
            presentation.sendKey(key)
            XCTAssertEqual(Array(pty.sent.last ?? Data()), expected[key])
            XCTAssertFalse(key.accessibilityLabel.hasPrefix("controlkey_"))
        }
        let count = pty.sent.count
        let isolated = IOSTerminalPresentation(session: core, allowsInput: false, reply: { _ in XCTFail("Isolated reply") })
        isolated.rendererMounted(cols: 50, rows: 20)
        isolated.visibilityChanged(visible: true, active: true)
        isolated.sendKey(.ctrlC)
        XCTAssertEqual(pty.sent.count, count)
        presentation.visibilityChanged(visible: false, active: true)
        presentation.sendKey(.enter)
        XCTAssertEqual(pty.sent.count, count)
        isolated.rendererUnmounted()
        presentation.rendererUnmounted()
    }

    func testRenderFixtureImages() async throws {
        // SwiftUI ImageRenderer cannot draw a UIViewRepresentable. Inject text output
        // into the same production detail chrome; live UIKit feed is tested above.
        let directory = URL(fileURLWithPath: "/private/tmp/claude-501/-Users-kai-osthoff-githubrepos-shepherd/36c6a6cb-46a0-4781-99da-a39e745b0a43/scratchpad/ios-terminal")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let session = PreviewData.session(name: "iOS live terminal", prompt: "Mirror the mobile web session view. Keep the terminal live and the controls within reach.")
        let pty = IOSFixturePTY()
        let core = TerminalSessionModel(sessionID: session.id, reply: { _ in }, makeAttachment: { _, _ in pty })
        let presentation = IOSTerminalPresentation(session: core, reply: { _ in })
        presentation.rendererMounted(cols: 54, rows: 32)
        presentation.visibilityChanged(visible: true, active: true)
        pty.emit(.attached)
        await settle { core.phase == .live }
        defer { presentation.rendererUnmounted() }
        let detail = DetailModel(loaders: .stubbed())
        let output = VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: "$ shepherd session attach TASK-01").foregroundStyle(IOSTerminalStyle.muted)
            Text(verbatim: "⏺ Reading native session detail…\n\n  Sources/Sessions/SessionDetailView.swift\n  Sources/Terminal/IOSTerminalHostView.swift\n\n⏺ Live PTY connected\n  Following output at 54 × 32\n\n⏺ Building the iPhone terminal surface…")
            Spacer()
        }.font(.system(size: 12, design: .monospaced)).padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(IOSTerminalStyle.background)
        for tab in [IOSSessionDetailTab.terminal, .info] {
            let view = IOSSessionDetailContent(session: session, model: detail, terminal: presentation,
                allowsInput: true, fontSize: .constant(12), surface: output, tab: tab, selectableText: false)
                .frame(width: 390, height: 760)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            let image = try XCTUnwrap(renderer.uiImage)
            try XCTUnwrap(image.pngData()).write(to: directory.appendingPathComponent("detail-\(tab).png"))
        }
        let large = IOSSessionDetailContent(session: session, model: detail, terminal: presentation,
            allowsInput: true, fontSize: .constant(12), surface: output, tab: .info, selectableText: false)
            .environment(\.dynamicTypeSize, .accessibility3).frame(width: 390, height: 760)
        let renderer = ImageRenderer(content: large)
        renderer.scale = 2
        try XCTUnwrap(renderer.uiImage?.pngData()).write(to: directory.appendingPathComponent("detail-info-large.png"))
    }

    private func settle(_ condition: () -> Bool) async {
        let deadline = ContinuousClock.now + .seconds(2)
        while !condition(), ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertTrue(condition())
    }
}

@MainActor
private final class IOSReplyRecorder {
    var texts: [String] = []
    var fail = false
    var hold = false
    var pending: CheckedContinuation<Void, Never>?
    func send(_ text: String) async throws {
        texts.append(text)
        if hold { await withCheckedContinuation { pending = $0 } }
        if fail { throw ShepherdError.notFound }
    }
}
