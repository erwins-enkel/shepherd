import XCTest
import SwiftUI
import UIKit
import ShepherdKit
@testable import ShepherdAppCore
@testable import ShepherdIOS

@MainActor
final class IOSSessionChromeTests: XCTestCase {
    func testClipboardPresenceUsesInjectedProbeAndRefreshesWithoutReadingImage() {
        var present = false, probes = 0
        let visibility = IOSClipboardVisibility(probe: { probes += 1; return present })
        XCTAssertFalse(visibility.hasImage)
        XCTAssertEqual(probes, 0)
        visibility.refresh()
        XCTAssertFalse(visibility.hasImage)
        present = true
        visibility.refresh()
        XCTAssertTrue(visibility.hasImage)
        present = false
        visibility.refresh()
        XCTAssertFalse(visibility.hasImage)
        XCTAssertEqual(probes, 3)
    }

    func testDraftDotTracksTextAndAttachmentsAndSurvivesHidingWriting() async {
        let f = ChromeFixture()
        defer { f.teardown() }
        XCTAssertFalse(f.model.hasDraft)
        f.core.promptText = " \n "
        XCTAssertFalse(f.model.hasDraft)
        f.core.promptText = "Keep this draft"
        f.model.openWriting(focus: true)
        XCTAssertTrue(f.model.showsWriting)
        XCTAssertTrue(f.model.writingWantsKeyboard)
        f.model.closeWriting()
        f.model.openWriting(focus: false)
        XCTAssertTrue(f.model.showsWriting)
        XCTAssertFalse(f.model.writingWantsKeyboard)
        f.model.closeWriting()
        XCTAssertTrue(f.model.hasDraft)
        XCTAssertEqual(f.core.promptText, "Keep this draft")
        f.core.promptText = ""
        f.uploads.addFiles([.init(name: "image.png", data: Data([1]))])
        XCTAssertTrue(f.model.hasDraft)
        f.uploads.rows.forEach { f.uploads.remove($0.id) }
        XCTAssertFalse(f.model.hasDraft)
    }

    func testImportUploadingFailureAndRetryGateSendAndNeverInjectPTY() async throws {
        let f = ChromeFixture()
        defer { f.teardown() }
        await f.live()
        f.core.promptText = "Please inspect"
        XCTAssertTrue(f.model.canSubmitReply)
        let stamp = try XCTUnwrap(f.uploads.beginImport())
        XCTAssertFalse(f.model.canSubmitReply)
        f.uploads.finishImport(.init(name: "image.png", data: Data([1])), error: nil, generation: stamp)
        await settle { f.pending != nil }
        XCTAssertFalse(f.model.canSubmitReply)
        let prematureSend = await f.model.submitReply()
        XCTAssertFalse(prematureSend)
        XCTAssertTrue(f.sent.isEmpty)
        XCTAssertTrue(f.pty.sent.isEmpty)
        f.failUpload = true
        f.release()
        await settle { f.uploads.rows.first?.state == .failed }
        XCTAssertFalse(f.model.canSubmitReply)
        XCTAssertNotNil(f.uploads.rows.first?.error)
        XCTAssertTrue(f.pty.sent.isEmpty)
        f.failUpload = false
        f.uploads.retry(try XCTUnwrap(f.uploads.rows.first?.id))
        await settle { f.pending != nil }
        XCTAssertFalse(f.model.canSubmitReply)
        f.release()
        await settle { !f.uploads.hasOutstandingUploads }
        XCTAssertTrue(f.model.canSubmitReply)
    }

    func testUploadedPathsAndVideoHintUseReplyChannelThenClearOnlyOnSuccess() async {
        let f = ChromeFixture()
        defer { f.teardown() }
        await f.live()
        f.uploads.addFiles([.init(name: "image.png", data: Data([1])), .init(name: "clip.mov", data: Data([2]))])
        await settle { f.pending != nil }
        f.release()
        await settle { f.uploads.rows.first?.state == .uploaded && f.pending != nil }
        f.release()
        await settle { !f.uploads.hasOutstandingUploads }
        f.core.promptText = " Inspect these. "
        f.failReply = true
        let failed = await f.model.submitReply()
        XCTAssertFalse(failed)
        XCTAssertEqual(f.uploads.rows.count, 2)
        XCTAssertEqual(f.core.promptText, " Inspect these. ")
        f.failReply = false
        let sent = await f.model.submitReply()
        XCTAssertTrue(sent)
        XCTAssertEqual(f.sent.last, "/worktree/image.png\n/worktree/clip.mov (screen-recording video — extract keyframes/audio with ffmpeg to view)\nInspect these.")
        XCTAssertFalse(f.model.hasDraft)
        XCTAssertTrue(f.uploads.rows.isEmpty)
        XCTAssertTrue(f.pty.sent.isEmpty)
    }

    func testAttachmentPayloadMatchesWebImageAndCaseInsensitiveVideoHint() {
        XCTAssertEqual(IOSAttachmentPaste.path("/a/image.png", mime: "image/png"), "/a/image.png")
        XCTAssertEqual(IOSAttachmentPaste.path("/a/clip.mp4", mime: "VIDEO/MP4"),
            "/a/clip.mp4 (screen-recording video — extract keyframes/audio with ffmpeg to view)")
        XCTAssertEqual(IOSAttachmentPaste.reply(paths: ["/a/file.pdf"], draft: ""), "/a/file.pdf")
    }

    func testAttachRequiresLiveForegroundPTYAndWritablePresentation() async {
        let f = ChromeFixture()
        defer { f.teardown() }
        XCTAssertFalse(f.model.canAttach)
        await f.live()
        XCTAssertTrue(f.model.canAttach)
        f.model.visibilityChanged(visible: false, active: false)
        XCTAssertFalse(f.model.canAttach)
        XCTAssertFalse(f.model.canSubmitReply)
        let readOnly = IOSTerminalPresentation(session: f.core, allowsInput: false, attachments: f.uploads, reply: { _ in XCTFail("Read-only reply") })
        XCTAssertFalse(readOnly.canAttach)
        XCTAssertFalse(readOnly.canSubmitReply)
    }

    func testRenderCompactChromeFixtures() async throws {
        let directory = URL(fileURLWithPath: "/private/tmp/claude-501/-Users-kai-osthoff-githubrepos-shepherd/ad0888ae-c724-4a2b-aaaa-616a5b42ecd8/scratchpad/ios-chrome/shots")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let record = PreviewData.session(desig: "TASK-1714", name: "footer-grafiken-signaturen")
        for name in ["resting", "clipboard", "writing", "attachments"] {
            let f = ChromeFixture()
            defer { f.teardown() }
            await f.live()
            if name == "writing" || name == "attachments" {
                f.model.writing = true
                f.core.promptText = "Prüfe bitte die Signaturen auf dem Screenshot."
            }
            var thumbnails: [UUID: UIImage] = [:]
            if name == "attachments" {
                f.uploads.addFiles([.init(name: "screenshot.png", data: Data([1]))])
                await settle { f.pending != nil }
                f.release()
                await settle { !f.uploads.hasOutstandingUploads }
                let thumbnail = ImageRenderer(content: VStack {
                    Image(systemName: "photo").foregroundStyle(ComposePalette.amber)
                    Text("Signature").font(.system(size: 8))
                }.frame(width: 40, height: 40).background(ComposePalette.panel2))
                if let id = f.uploads.rows.first?.id, let image = thumbnail.uiImage { thumbnails[id] = image }
                f.uploads.addFiles([.init(name: "design.pdf", data: Data([2]))])
                await settle { f.pending != nil }
            }
            let chips = IOSSteerChips(steers: [
                .init(id: "ok", label: "ok", text: "ok", inSteerBar: true, onIssues: false),
                .init(id: "follow", label: "folge dir", text: "folge dir", inSteerBar: true, onIssues: false),
                .init(id: "commit", label: "commit", text: "commit", inSteerBar: true, onIssues: false)
            ], terminal: f.model, openAll: {}, rendersStaticFixture: true)
            let output = VStack(alignment: .leading, spacing: 12) {
                Spacer()
                Text(verbatim: "⏺ Die Grafiken sind eingefügt und die Signaturen aktualisiert.")
                Text(verbatim: "  • Footer-Logo: neue Variante\n  • Signatur: Abstände korrigiert\n  • Mobile Darstellung geprüft")
                Text(verbatim: "⏺ Soll ich noch etwas anpassen?")
                Text(verbatim: "────────────────────────────────────────────\n› ▌ Tippen zum Schreiben\n────────────────────────────────────────────")
                    .foregroundStyle(IOSTerminalStyle.muted)
            }.font(.system(size: 12.5, design: .monospaced)).padding(12)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            let detail = IOSSessionDetailContent(session: record, model: DetailModel(loaders: .stubbed()), terminal: f.model,
                allowsInput: true, fontSize: .constant(12.5), surface: output, selectableText: false,
                steerChips: AnyView(chips), repoName: "epamano", back: {}, fixtureClipboard: name == "clipboard", fixtureThumbnails: thumbnails)
            let view = VStack(spacing: 0) {
                Color.clear.frame(height: 54)
                detail
                if name == "writing" { fixtureKeyboard }
                Color.clear.frame(height: 34)
            }.background(IOSTerminalStyle.background).frame(width: 402, height: 874)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            let image = try XCTUnwrap(renderer.uiImage)
            try XCTUnwrap(image.pngData()).write(to: directory.appendingPathComponent("\(name).png"))
            XCTAssertEqual(image.size, CGSize(width: 402, height: 874))
        }
    }
    private var fixtureKeyboard: some View {
        VStack(spacing: 8) {
            ForEach(["q w e r t z u i o p", "a s d f g h j k l", "⇧ y x c v b n m ⌫", "123       Leerzeichen       ↵"], id: \.self) { row in
                Text(verbatim: row).font(.system(.title3)).frame(maxWidth: .infinity, minHeight: 44)
            }
        }.padding(8).foregroundStyle(ComposePalette.ink).background(ComposePalette.panel2)
    }
    private func settle(_ condition: () -> Bool) async {
        let deadline = ContinuousClock.now + .seconds(15)
        while !condition(), ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertTrue(condition())
    }
}

@MainActor
private final class ChromeFixture {
    let pty = ChromePTY()
    var pending: CheckedContinuation<Void, Never>?
    var failUpload = false, failReply = false
    var sent: [String] = []
    lazy var uploads = AttachmentModel(upload: { _, name in try await self.upload(name) })
    func upload(_ name: String) async throws -> String {
        await withCheckedContinuation { pending = $0 }
        if failUpload { throw ShepherdError.notFound }
        return "/worktree/" + name
    }
    lazy var core = TerminalSessionModel(sessionID: "chrome", reply: { _ in }, makeAttachment: { _, _ in self.pty })
    lazy var model = IOSTerminalPresentation(session: core, attachments: uploads, reply: { text in try await self.reply(text) })
    func reply(_ text: String) throws { sent.append(text); if failReply { throw ShepherdError.notFound } }
    func live() async {
        model.rendererMounted(cols: 48, rows: 32)
        model.visibilityChanged(visible: true, active: true)
        pty.sink.yield(.attached)
        let deadline = ContinuousClock.now + .seconds(15)
        while core.phase != .live, ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertEqual(core.phase, .live)
    }
    func release() { pending?.resume(); pending = nil }
    func teardown() { release(); model.teardown() }
}

@MainActor
private final class ChromePTY: PTYAttaching {
    let output: AsyncStream<Data> = AsyncStream { _ in }
    let lifecycle: AsyncStream<PTYConnection.LifecycleEvent>
    let sink: AsyncStream<PTYConnection.LifecycleEvent>.Continuation
    var sent: [Data] = []
    init() { (lifecycle, sink) = AsyncStream.makeStream() }
    func start() {}
    func stop() {}
    func takeOver() {}
    func resize(cols: Int, rows: Int) {}
    func send(_ data: Data) { sent.append(data) }
}
