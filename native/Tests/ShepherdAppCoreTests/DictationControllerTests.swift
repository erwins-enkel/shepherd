import Foundation
import Testing
@testable import ShepherdAppCore

@MainActor struct DictationControllerTests {
    private final class Host { var text = "Existing."; var date = Date(timeIntervalSince1970: 100) }
    private final class DeferredFailureEngine: DictationEngine {
        let fake = FakeDictationEngine()
        var error: DictationError = .unsupported
        func start(locale: String) async throws -> AsyncStream<DictationEvent> { try await fake.start(locale: locale) }
        func finish() async throws -> DictationRecording { throw error }
        func cancel() async { await fake.cancel() }
    }
    @Test func deferredPermissionFailuresPreservePromptAndAllowNextRecording() async {
        for error in [DictationError.unsupported, .denied] {
            let host = Host(), engine = DeferredFailureEngine()
            engine.error = error
            let controller = DictationController(engine: engine, now: { host.date },
                getText: { host.text }, setText: { host.text = $0 })
            await controller.begin(); host.date.addTimeInterval(1)
            #expect(controller.state == .recording)
            controller.finalize(); await settle()
            #expect(controller.state == (error == .unsupported ? .unsupported : .denied))
            #expect(controller.noticeKey == (error == .unsupported ? "native_compose_voice_unsupported" : "native_compose_voice_denied"))
            #expect(host.text == "Existing."); #expect(!controller.active); #expect(engine.fake.cancelled)
            host.text += " Typed"; await controller.begin()
            #expect(controller.state == .recording); #expect(host.text == "Existing. Typed")
            controller.teardown()
        }
    }
    @Test func livePreviewAvailabilityTracksAppleAndResetsAcrossPresses() async {
        let host = Host(), engine = FakeDictationEngine()
        let c = make(host, engine)
        await c.begin(); #expect(!c.livePreviewAvailable)
        engine.emit(.livePreview(true)); engine.emit(.preview("Apple")); await settle()
        #expect(c.livePreviewAvailable); #expect(c.preview == "Apple")
        engine.emit(.livePreview(false)); engine.emit(.level(0.7)); await settle()
        #expect(!c.livePreviewAvailable); #expect(c.level == 0.7); #expect(c.state == .recording)
        c.cancel(); await c.begin(); #expect(!c.livePreviewAvailable); #expect(c.preview.isEmpty)
        c.teardown()
    }
    private func make(_ host: Host, _ engine: FakeDictationEngine, finalizer: (any DictationFinalizer)? = nil) -> DictationController {
        DictationController(engine: engine, finalizer: finalizer, now: { host.date }, getText: { host.text }, setText: { host.text = $0 })
    }
    private func settle() async { for _ in 0..<40 { await Task.yield() } }
    @Test func finalTextAppendsAndUndoDoesNotEraseLaterTyping() async {
        let host = Host(), engine = FakeDictationEngine(); engine.recording = .init(clips: [], appleText: "New task.")
        let controller = make(host, engine)
        await controller.begin(); engine.emit(.volatile("Preview")); await settle()
        #expect(host.text == "Existing."); #expect(controller.preview == "Preview")
        host.date.addTimeInterval(1); controller.release(); await settle()
        #expect(host.text == "Existing. New task."); #expect(controller.canUndo)
        controller.undo(); #expect(host.text == "Existing.")
        await controller.begin(); host.date.addTimeInterval(1); controller.finalize(); await settle()
        host.text += " Typed"; controller.undo(); #expect(host.text.hasSuffix("Typed"))
    }
    @Test func lockedCheckpointsDoNotDuplicateCumulativePreview() async {
        let host = Host(), engine = FakeDictationEngine()
        engine.recording = .init(clips: [], appleText: "First. Second.")
        let c = make(host, engine); await c.begin(locked: true)
        engine.emit(.checkpoint("First.")); engine.emit(.preview("First. Second.")); await settle()
        #expect(host.text == "Existing. First."); #expect(c.preview == "First. Second.")
        engine.emit(.checkpoint("First. Second.")); await settle()
        #expect(host.text == "Existing. First. Second.")
        host.date.addTimeInterval(1); c.finalize(); await settle()
        #expect(host.text == "Existing. First. Second.")
    }
    @Test func cancelGeometryCanReturnAndLockDoesNotUnlockOnRelease() async {
        let host = Host(), engine = FakeDictationEngine(), controller = make(Host(), FakeDictationEngine())
        #expect(HoldGesture.classify(x: -80, y: -20) == .cancel)
        #expect(HoldGesture.classify(x: -80, y: -100) == .lock)
        let c = make(host, engine); await c.begin(); c.drag(x: -90, y: 0); #expect(c.state == .cancelling)
        c.drag(x: 0, y: 0); #expect(c.state == .recording)
        c.drag(x: 0, y: -60); c.release(); #expect(c.state == .locked)
        c.drag(x: -100, y: 0); #expect(c.state == .locked); c.cancel(); await settle()
        #expect(host.text == "Existing."); #expect(engine.cancelled)
        #expect(controller.state == .idle)
    }
    @Test func shortClipAndArmingReleaseDiscard() async {
        let host = Host(), engine = FakeDictationEngine(); engine.recording = .init(clips: [], appleText: "Discard")
        let c = make(host, engine); await c.begin(); host.date.addTimeInterval(0.2); c.release(); await settle()
        #expect(c.state == .idle); #expect(host.text == "Existing.")
    }
    @Test func lockedStableTextIsReplacedByWhisperAndCancelRestores() async {
        let host = Host(), engine = FakeDictationEngine(); engine.recording = .init(clips: [.init(wav: Data([1]), appleText: "Apple")], appleText: "Apple")
        let finalizer = WhisperFinalizer(status: { true }, transcribe: { _, _ in "Whisper" })
        let c = make(host, engine, finalizer: finalizer); await c.begin(locked: true)
        engine.emit(.final("Apple")); await settle(); #expect(host.text == "Existing. Apple")
        host.date.addTimeInterval(1); c.finalize(); await settle(); #expect(host.text == "Existing. Whisper")
        c.teardown(); await settle(); #expect(host.text == "Existing. Whisper")
        await c.begin(locked: true); engine.emit(.final("Temporary")); await settle(); c.cancel(); await settle()
        #expect(host.text == "Existing. Whisper")
    }
    @Test func interruptionAndDurationCapFinalizeWithoutSending() async {
        let host = Host(), engine = FakeDictationEngine(); engine.recording = .init(clips: [], appleText: "Safe")
        let c = make(host, engine); await c.begin(); host.date.addTimeInterval(301); c.tick(); await settle()
        #expect(host.text == "Existing. Safe"); #expect(c.noticeKey == "native_compose_voice_limit")
        await c.begin(); host.date.addTimeInterval(1); engine.emit(.interrupted); await settle()
        #expect(c.state == .idle); #expect(c.noticeKey == "native_compose_voice_interrupted")
    }
    @Test func permissionErrorsAndUnsupportedRemainTypeable() async {
        for error in [DictationError.denied, .unsupported, .audio] {
            let host = Host(), engine = FakeDictationEngine(); engine.startError = error
            let c = make(host, engine); await c.begin()
            #expect(c.state == (error == .denied ? .denied : error == .unsupported ? .unsupported : .error))
            #expect(host.text == "Existing.")
        }
    }
    @Test func timeoutAndTeardownFenceLateServerResults() async throws {
        let host = Host(), engine = FakeDictationEngine(); engine.recording = .init(clips: [.init(wav: Data([1]), appleText: "Apple final")], appleText: "Apple final")
        let finalizer = WhisperFinalizer(status: { true }, requestTimeout: 0.01, transcribe: { _, _ in try? await Task.sleep(for: .milliseconds(50)); return "Late server" })
        let c = DictationController(engine: engine, finalizer: finalizer, finalizationTimeout: 0.01, now: { host.date }, getText: { host.text }, setText: { host.text = $0 })
        await c.begin(); host.date.addTimeInterval(1); c.finalize()
        try await Task.sleep(for: .milliseconds(90)); #expect(host.text == "Existing. Apple final")
        await c.begin(); host.date.addTimeInterval(1); c.finalize(); c.teardown()
        try await Task.sleep(for: .milliseconds(90)); #expect(host.text == "Existing. Apple final")
    }
    @Test func fallbackIsPerClipAndAbsentPluginSkipsUpload() async {
        let recording = DictationRecording(clips: [.init(wav: Data([1]), appleText: "One"), .init(wav: Data([2]), appleText: "Two")], appleText: "One Two")
        let f = WhisperFinalizer(status: { true }, transcribe: { bytes, lang in
            #expect(lang == "de"); if bytes == Data([2]) { throw DictationError.network }; return "Eins"
        })
        #expect(await f.finalize(recording, locale: "de-DE") == .init(text: "Eins Two"))
        let absent = WhisperFinalizer(status: { false }, transcribe: { _, _ in Issue.record("must not upload"); return "" })
        #expect(await absent.finalize(recording, locale: "en-US") == .init(text: "One Two"))
    }
    @Test func discoveryDeadlineDoesNotDelayOfflineAppleFallback() async {
        let result = await DictationDeadline.value(seconds: 0.01) {
            try? await Task.sleep(for: .milliseconds(100))
            return true
        }
        #expect(result == nil)
    }
    @Test func whisperTimeoutPreservesCompletedClipsInOrderAndReportsMissingText() async throws {
        let host = Host(), engine = FakeDictationEngine()
        engine.recording = .init(clips: (1...3).map { .init(wav: Data([UInt8($0)]), appleText: "") }, appleText: "")
        let finalizer = WhisperFinalizer(status: { true }, requestTimeout: 0.01, transcribe: { bytes, _ in
            if bytes == Data([2]) {
                // A transport may ignore cancellation; late text must never replace the result.
                try? await Task.sleep(for: .milliseconds(100)); return "Late second"
            }
            return bytes == Data([1]) ? "First" : "Third"
        })
        let result = await finalizer.finalize(engine.recording, locale: "en-US")
        #expect(result == .init(text: "First Third", missingClips: [1]))
        let c = make(host, engine, finalizer: finalizer)
        await c.begin(); host.date.addTimeInterval(1); c.finalize()
        try await Task.sleep(for: .milliseconds(150))
        #expect(host.text == "Existing. First Third")
        #expect(c.noticeKey == "native_compose_voice_incomplete")
        #expect(c.noticeCopy != nil); #expect(c.state == .error); #expect(c.canUndo)
        c.undo(); #expect(host.text == "Existing.")
    }
    @Test func eachWhisperRequestGetsItsOwnDeadlineBeyondCaptureShutdownTimeout() async throws {
        let host = Host(), engine = FakeDictationEngine()
        engine.recording = .init(clips: (1...3).map { .init(wav: Data([UInt8($0)]), appleText: "") }, appleText: "")
        let finalizer = WhisperFinalizer(status: { true }, requestTimeout: 1, transcribe: { bytes, _ in
            try await Task.sleep(for: .milliseconds(30)); return "Clip\(bytes[0])"
        })
        let c = DictationController(engine: engine, finalizer: finalizer, finalizationTimeout: 0.01,
            now: { host.date }, getText: { host.text }, setText: { host.text = $0 })
        await c.begin(); host.date.addTimeInterval(1); c.finalize()
        try await Task.sleep(for: .milliseconds(200))
        #expect(host.text == "Existing. Clip1 Clip2 Clip3")
        #expect(c.noticeKey == nil); #expect(c.state == .idle)
    }
    @Test func whisperFailureEmptyTextAndAbsentPluginReportClipsWithoutFallback() async {
        let recording = DictationRecording(clips: [
            .init(wav: Data([1]), appleText: "Apple one"),
            .init(wav: Data([2]), appleText: ""),
            .init(wav: Data([3]), appleText: " ")], appleText: "Apple one")
        let failed = WhisperFinalizer(status: { true }, transcribe: { bytes, _ in
            if bytes == Data([3]) { return " \n" }; throw DictationError.network
        })
        #expect(await failed.finalize(recording, locale: "en-US") == .init(text: "Apple one", missingClips: [1, 2]))
        let absent = WhisperFinalizer(status: { false }, transcribe: { _, _ in Issue.record("must not upload"); return "" })
        #expect(await absent.finalize(recording, locale: "en-US") == .init(text: "Apple one", missingClips: [1, 2]))
        let host = Host(), engine = FakeDictationEngine()
        engine.recording = .init(clips: [.init(wav: Data([2]), appleText: "")], appleText: "")
        let c = make(host, engine, finalizer: failed)
        await c.begin(); host.date.addTimeInterval(1); c.finalize(); await settle()
        #expect(host.text == "Existing."); #expect(c.state == .error)
        #expect(c.noticeKey == "native_compose_voice_incomplete"); #expect(!c.canUndo)
    }
    @Test func accessibleToggleStartsLockedAndFinalizesWithoutHold() async {
        let host = Host(), engine = FakeDictationEngine(); engine.recording = .init(clips: [], appleText: "Tapped")
        let c = make(host, engine); c.toggle(); await settle()
        #expect(c.state == .locked)
        host.date.addTimeInterval(1); c.toggle(); await settle()
        #expect(c.state == .idle); #expect(host.text == "Existing. Tapped")
    }
    @Test func wavMatchesWebHeaderAndResampling() {
        let wav = DictationWAV.encode([0, 1, -1, 0], inputRate: 32_000)
        #expect(wav.count == 48)
        #expect(String(decoding: wav.prefix(4), as: UTF8.self) == "RIFF")
        #expect(Array(wav.suffix(4)) == [0,0,0,128])
        #expect(Array(wav[24..<28]) == [128,62,0,0])
    }
    @Test func separatorUndoExpiryAndLocalePersistence() async {
        #expect(DictationController.append("Existing\n", " word ") == "Existing\nword")
        let host = Host(), engine = FakeDictationEngine(); engine.recording = .init(clips: [], appleText: "New")
        let c = make(host, engine); await c.begin(); host.date.addTimeInterval(1); c.finalize(); await settle()
        host.date.addTimeInterval(6); c.tick(); c.undo(); #expect(host.text == "Existing. New")
        let name = "dictation-test-\(UUID())"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let p = DictationController(engine: engine, defaults: defaults, getText: { "" }, setText: { _ in })
        p.locale = "en-US"; #expect(defaults.string(forKey: "shepherd:dictation-language") == "en-US")
    }
}
