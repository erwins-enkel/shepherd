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
    func testAttachmentRequiresActiveVisibleRendererAndClosesOnEveryExit() {
        var attachments: [IOSFixturePTY] = []
        let session = TerminalSessionModel(sessionID: "fixture", reply: { _ in }, makeAttachment: { _, _ in
            let pty = IOSFixturePTY(); attachments.append(pty); return pty
        })
        let presentation = IOSTerminalPresentation(session: session)
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
        let presentation = IOSTerminalPresentation(session: session)
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
        let presentation = IOSTerminalPresentation(session: session)
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
        let presentation = IOSTerminalPresentation(session: session)
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
        let presentation = IOSTerminalPresentation(session: session)
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
        presentation.rendererUnmounted()
    }

    func testRenderFixtureImages() throws {
        // SwiftUI ImageRenderer cannot draw a UIViewRepresentable. Inject text output
        // into the same production detail chrome; live UIKit feed is tested above.
        let directory = URL(fileURLWithPath: "/private/tmp/claude-501/-Users-kai-osthoff-githubrepos-shepherd/36c6a6cb-46a0-4781-99da-a39e745b0a43/scratchpad/ios-terminal")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let session = PreviewData.session(name: "iOS live terminal", prompt: "Mirror the mobile web session view. Keep the terminal live and the controls within reach.")
        let core = TerminalSessionModel(sessionID: session.id, reply: { _ in }, makeAttachment: { _, _ in IOSFixturePTY() })
        let presentation = IOSTerminalPresentation(session: core)
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
                allowsInput: false, fontSize: .constant(12), surface: output, tab: tab)
                .frame(width: 390, height: 760)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            let image = try XCTUnwrap(renderer.uiImage)
            try XCTUnwrap(image.pngData()).write(to: directory.appendingPathComponent("detail-\(tab).png"))
        }
        let large = IOSSessionDetailContent(session: session, model: detail, terminal: presentation,
            allowsInput: false, fontSize: .constant(12), surface: output, tab: .info)
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
