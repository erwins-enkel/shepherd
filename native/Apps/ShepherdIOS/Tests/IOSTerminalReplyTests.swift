import XCTest
import SwiftUI
import UIKit
import ShepherdKit
@testable import ShepherdAppCore
@testable import ShepherdIOS

@MainActor
final class IOSTerminalReplyTests: XCTestCase {
    func testEndedSessionOffersResumeOnlyForSharedEligibleWritableSessions() async {
        let f = ReplyFixture()
        defer { f.teardown() }
        await f.end(.gone)
        XCTAssertTrue(f.model.canResume)
        f.writable = false
        XCTAssertFalse(f.model.canResume)
        await f.model.resume()
        XCTAssertEqual(f.resumes, 0)
        f.writable = true
        for status in [SessionStatusKnown.archived, .running, .blocked] {
            f.record.status = .init(known: status)
            XCTAssertFalse(f.model.canResume)
        }
        f.record.status = .init(known: .done)
        f.record.claudeSessionId = ""
        XCTAssertFalse(f.model.canResume)
        f.record.agentProvider = .codex
        XCTAssertTrue(f.model.canResume)
        f.record.terminal = true
        XCTAssertFalse(f.model.canResume)
    }

    func testResumeUsesSessionActionProgressFailureAndSuccessfulReattach() async {
        let f = ReplyFixture()
        defer { f.teardown() }
        await f.end(.gone)
        f.holdResume = true
        let failed = Task { await f.model.resume() }
        await settle { f.pending != nil }
        XCTAssertTrue(f.state.busy)
        await f.model.resume()
        XCTAssertEqual(f.resumes, 1)
        f.resumeError = ShepherdError.notFound
        f.release()
        await failed.value
        XCTAssertEqual(f.model.actionState?.error, L.t("cardmenu_resume_failed", f.record.name))
        XCTAssertEqual(f.core.phase, .ended(.gone))
        XCTAssertEqual(f.pty.takeovers, 0)
        f.resumeError = nil
        await f.model.resume()
        XCTAssertEqual(f.resumes, 2)
        XCTAssertEqual(f.pty.takeovers, 1)
        XCTAssertEqual(f.core.phase, .connecting)
        f.pty.emit(.attached)
        await settle { f.core.phase == .live }
        XCTAssertNil(f.state.error)
    }

    func testReconnectNeverResumesAndReadOnlyHasNoReplyBar() async {
        let f = ReplyFixture()
        defer { f.teardown() }
        await f.end(.unreachable)
        XCTAssertFalse(f.model.canResume)
        await f.model.resume()
        XCTAssertEqual(f.resumes, 0)
        let isolated = IOSTerminalPresentation(session: f.core, allowsInput: false,
            actions: { f.state }, reply: { _ in XCTFail("Read-only reply") })
        XCTAssertFalse(isolated.showsReplyBar)
        XCTAssertFalse(isolated.canRecordReply)
        isolated.prepareDictation()
        XCTAssertNil(isolated.voice)
        await isolated.resume()
        XCTAssertEqual(f.resumes, 0)
    }

    func testResumeCompletingOffscreenDefersAttachUntilVisibleRenderer() async {
        let f = ReplyFixture()
        defer { f.teardown() }
        await f.end(.gone)
        f.holdResume = true
        let resume = Task { await f.model.resume() }
        await settle { f.pending != nil }
        f.model.rendererUnmounted()
        f.model.visibilityChanged(visible: false, active: false)
        f.release()
        await resume.value
        XCTAssertEqual(f.pty.takeovers, 0)
        XCTAssertFalse(f.model.isAttached)
        f.model.visibilityChanged(visible: true, active: true)
        XCTAssertEqual(f.pty.starts, 1)
        f.model.rendererMounted(cols: 48, rows: 24)
        XCTAssertEqual(f.attachments.count, 2)
        XCTAssertEqual(f.pty.starts, 1)
        f.pty.emit(.attached)
        await settle { f.core.phase == .live }
    }

    func testSharedRailResumeReattachesOnlyOnTransitionToRunning() async {
        let f = ReplyFixture()
        defer { f.teardown() }
        await f.end(.gone)
        f.model.serverSessionChanged(.init(known: .done))
        f.model.serverSessionChanged(.init(known: .done))
        XCTAssertEqual(f.pty.takeovers, 0)
        f.model.serverSessionChanged(.init(known: .running))
        XCTAssertEqual(f.pty.takeovers, 1)
        f.model.serverSessionChanged(.init(known: .running))
        XCTAssertEqual(f.pty.takeovers, 1)
        XCTAssertEqual(f.resumes, 0)
    }

    func testVoiceIdleTypingRecordingLockedFinalizingAndExplicitSend() async {
        let f = ReplyFixture()
        defer { f.teardown() }
        await f.live()
        XCTAssertTrue(f.model.canRecordReply)
        XCTAssertFalse(f.model.canSubmitReply)
        f.core.promptText = "Existing draft."
        XCTAssertTrue(f.model.canSubmitReply)
        await f.voice.begin()
        XCTAssertEqual(f.voice.state, .recording)
        XCTAssertFalse(f.model.canSubmitReply)
        f.engine.emit(.preview("Add regression tests"))
        await settle { f.voice.preview == "Add regression tests" }
        XCTAssertEqual(f.core.promptText, "Existing draft.")
        f.voice.drag(x: 0, y: -70)
        XCTAssertEqual(f.voice.state, .locked)
        f.engine.emit(.checkpoint("Add regression tests"))
        await settle { f.core.promptText.contains("regression") }
        XCTAssertTrue(f.sent.isEmpty)
        f.clock += 2
        f.engine.recording = .init(clips: [], appleText: "Add regression tests.")
        f.voice.finalize()
        XCTAssertEqual(f.voice.state, .finalizing)
        XCTAssertFalse(f.model.canSubmitReply)
        await settle { !f.voice.active }
        XCTAssertEqual(f.core.promptText, "Existing draft. Add regression tests.")
        XCTAssertTrue(f.sent.isEmpty)
        XCTAssertTrue(f.model.canSubmitReply)
        let success = await f.model.submitReply()
        XCTAssertTrue(success)
        XCTAssertEqual(f.sent, ["Existing draft. Add regression tests."])
        XCTAssertTrue(f.core.promptText.isEmpty)
    }

    func testSharedControllerSlideCancelUndoAndPermissionErrorPreserveDraft() async {
        let f = ReplyFixture()
        defer { f.teardown() }
        await f.live()
        f.core.promptText = "Keep this"
        await f.voice.begin()
        f.voice.drag(x: -100, y: 0)
        XCTAssertEqual(f.voice.state, .cancelling)
        f.voice.release()
        XCTAssertEqual(f.core.promptText, "Keep this")
        await f.voice.begin(locked: true)
        f.clock += 2
        f.engine.recording = .init(clips: [], appleText: "added text")
        f.voice.finalize()
        await settle { f.voice.canUndo }
        XCTAssertEqual(f.core.promptText, "Keep this added text")
        f.voice.undo()
        XCTAssertEqual(f.core.promptText, "Keep this")
        f.engine.startError = .denied
        await f.voice.begin()
        XCTAssertEqual(f.voice.state, .denied)
        XCTAssertNotNil(f.voice.noticeCopy)
        XCTAssertTrue(f.model.canSubmitReply)
        XCTAssertTrue(f.sent.isEmpty)
    }

    func testSendingAndFailureDisableRecordingRetainEditableDraft() async {
        let f = ReplyFixture()
        defer { f.teardown() }
        await f.live()
        f.core.promptText = "Keep after failure"
        f.holdReply = true
        let send = Task { await f.model.submitReply() }
        await settle { f.pending != nil }
        XCTAssertTrue(f.model.replying)
        XCTAssertFalse(f.model.canRecordReply)
        XCTAssertFalse(f.model.canSubmitReply)
        f.replyError = ShepherdError.notFound
        f.release()
        let success = await send.value
        XCTAssertFalse(success)
        XCTAssertEqual(f.core.promptText, "Keep after failure")
        XCTAssertNotNil(f.model.replyError)
        XCTAssertTrue(f.model.canRecordReply)
        XCTAssertTrue(f.model.canSubmitReply)
    }

    func testWhisperFinalReplacesApplePreviewWithoutSending() async {
        let f = ReplyFixture()
        defer { f.teardown() }
        await f.live()
        let finalizer = WhisperFinalizer(status: { true }, transcribe: { _, language in
            XCTAssertEqual(language, "de"); return "Final Whisper transcript"
        })
        let voice = DictationController(engine: f.engine, finalizer: finalizer, locale: "de-DE",
            now: { Date(timeIntervalSince1970: f.clock) },
            getText: { f.core.promptText }, setText: { f.core.promptText = $0 })
        f.model.installVoice(voice)
        await voice.begin()
        f.engine.emit(.preview("Apple preview"))
        await settle { voice.preview == "Apple preview" }
        f.clock += 2
        f.engine.recording = .init(clips: [.init(wav: Data([1]), appleText: "Apple preview")], appleText: "Apple preview")
        voice.finalize()
        await settle { !voice.active }
        XCTAssertEqual(f.core.promptText, "Final Whisper transcript")
        XCTAssertTrue(f.sent.isEmpty)
    }

    func testSuspensionFinalizesAndTeardownRejectsLateDictation() async {
        let f = ReplyFixture()
        defer { f.teardown() }
        await f.live()
        await f.voice.begin(locked: true)
        f.clock += 2
        f.engine.recording = .init(clips: [], appleText: "Retained on suspension")
        f.model.visibilityChanged(visible: true, active: false)
        await settle { !f.voice.active }
        XCTAssertEqual(f.core.promptText, "Retained on suspension")
        XCTAssertTrue(f.sent.isEmpty)
        await f.voice.begin()
        f.model.teardown()
        f.engine.emit(.checkpoint("Late text"))
        XCTAssertEqual(f.core.promptText, "Retained on suspension")
    }

    func testSharedWhisperDiscoveryCoalescesCachesRetriesAndInvalidates() async throws {
        let gate = StatusGate()
        let status = IOSWhisperStatus(read: { try await gate.read() })
        let a = Task { try await status.value() }, b = Task { try await status.value() }
        await settle { gate.pending != nil }
        XCTAssertEqual(gate.reads, 1)
        gate.release(true)
        let first = try await a.value, second = try await b.value
        XCTAssertTrue(first && second)
        let cached = try await status.value()
        XCTAssertTrue(cached)
        XCTAssertEqual(gate.reads, 1)
        status.teardown()
        do { _ = try await status.value(); XCTFail("Torn-down activation") } catch {}
        let retry = IOSWhisperStatus(read: { try await gate.read() })
        let failure = Task { try await retry.value() }
        await settle { gate.pending != nil }
        gate.fail()
        do { _ = try await failure.value; XCTFail("Expected failure") } catch {}
        let next = Task { try await retry.value() }
        await settle { gate.pending != nil }
        gate.release(false)
        let unavailable = try await next.value
        XCTAssertFalse(unavailable)
        XCTAssertEqual(gate.reads, 3)
        retry.teardown()
    }

    func testRenderTerminalReplyStates() async throws {
        let directory = URL(fileURLWithPath: "/private/tmp/claude-501/-Users-kai-osthoff-githubrepos-shepherd/36c6a6cb-46a0-4781-99da-a39e745b0a43/scratchpad/ios-reply")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for name in ["ended-resume", "idle", "recording", "locked", "transcript", "finalizing", "sending", "error", "large-type"] {
            let f = ReplyFixture()
            defer { f.teardown() }
            if name == "finalizing" { f.finalizer = ReplyFinalizer() }
            await f.live()
            if name == "ended-resume" { await f.end(.gone) }
            if name == "transcript" { f.core.promptText = "Prüfe die Tests und ergänze die deutsche Beschriftung." }
            if name == "recording" || name == "locked" {
                await f.voice.begin(locked: name == "locked")
                f.engine.emit(.preview("Prüfe die Tests und ergänze die deutsche Beschriftung…"))
                f.engine.emit(.level(0.8))
                await settle { !f.voice.preview.isEmpty && f.voice.level > 0 }
                f.clock += 12; f.voice.tick()
            }
            if name == "finalizing" {
                await f.voice.begin()
                f.engine.recording = .init(clips: [], appleText: "Prüfe die Tests…")
                f.clock += 2
                f.voice.finalize()
                await settle { (f.finalizer as? ReplyFinalizer)?.pending != nil }
            }
            var sending: Task<Bool, Never>?
            if name == "sending" || name == "error" {
                f.core.promptText = "Prüfe die Tests und ergänze die deutsche Beschriftung."
                if name == "sending" {
                    f.holdReply = true
                    sending = Task { await f.model.submitReply() }
                    await settle { f.model.replying }
                } else {
                    f.replyError = ShepherdError.notFound
                    _ = await f.model.submitReply()
                }
            }
            let output = VStack(alignment: .leading, spacing: 12) {
                Text(verbatim: "$ shepherd session attach TASK-01").foregroundStyle(IOSTerminalStyle.muted)
                Text(verbatim: "⏺ Checking the iOS terminal…\n\n  Shared session actions\n  Apple live preview + Whisper final\n\n⏺ Ready for your reply")
                Spacer()
            }.font(.system(.caption, design: .monospaced)).padding(12)
            let content = IOSTerminalPane(model: f.model, allowsInput: true, surface: output,
                fontSize: .constant(12), rendersStaticFixture: true)
                .frame(width: 390, height: 760)
                .background(IOSTerminalStyle.background).foregroundStyle(IOSTerminalStyle.ink)
                .tint(IOSTerminalStyle.amber).preferredColorScheme(.dark)
                .environment(\.dynamicTypeSize, name == "large-type" ? .accessibility3 : .large)
            let stateBeforeRendering = f.voice.state
            let renderer = ImageRenderer(content: content); renderer.scale = 2
            try XCTUnwrap(renderer.uiImage?.pngData()).write(to: directory.appendingPathComponent("terminal-\(name).png"))
            XCTAssertEqual(f.voice.state, stateBeforeRendering, "Rendering must preserve the fixture recording state")
            f.release()
            if let sending { _ = await sending.value }
        }
    }

    private func settle(_ condition: () -> Bool) async {
        let deadline = ContinuousClock.now + .seconds(10)
        while !condition(), ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertTrue(condition())
    }
}

@MainActor
private final class ReplyPTY: PTYAttaching {
    let output: AsyncStream<Data> = AsyncStream { _ in }
    let lifecycle: AsyncStream<PTYConnection.LifecycleEvent>
    private let sink: AsyncStream<PTYConnection.LifecycleEvent>.Continuation
    var starts = 0, takeovers = 0
    init() { (lifecycle, sink) = AsyncStream.makeStream() }
    func start() { starts += 1 }
    func stop() {}
    func takeOver() { takeovers += 1 }
    func send(_ bytes: Data) {}
    func resize(cols: Int, rows: Int) {}
    func emit(_ event: PTYConnection.LifecycleEvent) { sink.yield(event) }
}

@MainActor
private final class ReplyFixture {
    var record = PreviewData.session(name: "Terminal reply")
    var writable = true, holdResume = false, holdReply = false
    var resumes = 0
    var clock: TimeInterval = 100
    var resumeError: ShepherdError?, replyError: ShepherdError?
    var pending: CheckedContinuation<Void, Never>?
    var sent: [String] = []
    var finalizer: (any DictationFinalizer)?
    var pty = ReplyPTY()
    var attachments: [ReplyPTY] = []
    let engine = FakeDictationEngine()
    let merge = MergeModel(reads: .init(snapshot: { MergeSnapshot() }))
    let rules = ActionsModel(reads: .init(recaps: { [:] }), now: { 1 })
    lazy var core = TerminalSessionModel(sessionID: record.id, reply: { _ in }, makeAttachment: { _, _ in
        if self.pty.starts > 0 { self.pty = ReplyPTY() }
        self.attachments.append(self.pty)
        return self.pty
    })
    lazy var voice = DictationController(engine: engine, finalizer: finalizer, locale: "de-DE", now: { Date(timeIntervalSince1970: self.clock) },
        getText: { self.core.promptText }, setText: { self.core.promptText = $0 })
    lazy var state = IOSSessionActionState(operations: .init(
        stop: { _ in throw ShepherdError.notFound },
        resume: { _ in try await self.resumeSession() }, ready: { _, _ in throw ShepherdError.notFound }, rename: { _, _ in throw ShepherdError.notFound },
        amend: { _, _, _ in throw ShepherdError.notFound }, relaunch: { _, _ in throw ShepherdError.notFound },
        recap: { _ in throw ShepherdError.notFound }, git: { _ in throw ShepherdError.notFound },
        merge: { _, _, _, _ in throw ShepherdError.notFound }), merge: merge,
        session: { self.record }, actions: { self.rules.actions(for: $0) },
        canWrite: { self.writable }, isSelected: { true }, canSelectReplacement: { false }, selectReplacement: { _, _ in })
    lazy var model = IOSTerminalPresentation(session: core, actions: { self.state }, reply: { text in
        try await self.send(text)
    })
    init() { record.status = .init(known: .done) }
    func resumeSession() async throws {
        resumes += 1
        if holdResume { await withCheckedContinuation { pending = $0 } }
        if let resumeError { throw resumeError }
    }
    func send(_ text: String) async throws {
        sent.append(text)
        if holdReply { await withCheckedContinuation { pending = $0 } }
        if let replyError { throw replyError }
    }
    func release() { holdResume = false; holdReply = false; pending?.resume(); pending = nil }
    func live() async {
        model.installVoice(voice)
        model.visibilityChanged(visible: true, active: true)
        model.rendererMounted(cols: 48, rows: 24)
        pty.emit(.attached)
        await wait { self.core.phase == .live }
    }
    func end(_ closure: PTYConnection.Closure) async {
        if !model.isAttached { await live() }
        pty.emit(.closed(closure))
        await wait { self.core.phase == .ended(closure) }
    }
    private func wait(_ condition: () -> Bool) async {
        let deadline = ContinuousClock.now + .seconds(10)
        while !condition(), ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertTrue(condition())
    }
    func teardown() { release(); model.teardown(); (finalizer as? ReplyFinalizer)?.release(); state.invalidate(); merge.teardown(); rules.teardown() }
}

@MainActor
private final class ReplyFinalizer: DictationFinalizer {
    var pending: CheckedContinuation<DictationFinalization, Never>?
    func finalize(_ recording: DictationRecording, locale: String) async -> DictationFinalization {
        await withCheckedContinuation { pending = $0 }
    }
    func release() { pending?.resume(returning: .init(text: "Final text")); pending = nil }
}

@MainActor
private final class StatusGate {
    var reads = 0
    var pending: CheckedContinuation<Bool, any Error>?
    func read() async throws -> Bool {
        reads += 1
        return try await withCheckedThrowingContinuation { pending = $0 }
    }
    func release(_ value: Bool) { pending?.resume(returning: value); pending = nil }
    func fail() { pending?.resume(throwing: ShepherdError.notFound); pending = nil }
}
