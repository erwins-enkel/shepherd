import XCTest
import AVFoundation
import Speech
import SwiftUI
import ShepherdAppCore
@testable import ShepherdIOS

@MainActor
final class IOSDictationTests: XCTestCase {
    private final class Capture: DictationAudioCapture {
        var continuation: AsyncStream<AudioCapture.Event>.Continuation?
        var stopped = true
        func start() throws -> AsyncStream<AudioCapture.Event> {
            let pair = AsyncStream<AudioCapture.Event>.makeStream()
            continuation = pair.continuation; stopped = false; return pair.stream
        }
        func stop() { stopped = true; continuation?.finish(); continuation = nil }
        func emit(rate: Double = 16_000) throws {
            let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1))
            let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 2))
            buffer.frameLength = 2; buffer.floatChannelData![0][0] = 0.5; buffer.floatChannelData![0][1] = -0.5
            continuation?.yield(.audio(try XCTUnwrap(CapturedAudio(buffer))))
        }
    }
    private final class Speech: AppleLiveSpeech {
        var suspend = false
        var startup: CheckedContinuation<Void, any Error>?
        var cancelled = false
        var appended = 0
        var failAppend = false
        var failed: () -> Void = {}
        func start() async throws {
            if suspend { try await withCheckedThrowingContinuation { startup = $0 } }
        }
        func append(_ buffer: AVAudioPCMBuffer) throws {
            if failAppend { throw DictationError.recognition }; appended += 1
        }
        func finish() async -> String { "Apple" }
        func cancel() { cancelled = true }
    }
    @MainActor private final class Probe {
        var calls = 0
        var continuations: [Int: CheckedContinuation<Bool, any Error>] = [:]
        var failFirst = false
        var alwaysFail = false
        func status() async throws -> Bool {
            calls += 1
            if alwaysFail || failFirst && calls == 1 { throw DictationError.network }
            return try await withCheckedThrowingContinuation { continuations[calls] = $0 }
        }
        func resolve(_ available: Bool, call: Int? = nil) {
            for key in call.map({ [$0] }) ?? Array(continuations.keys) {
                continuations.removeValue(forKey: key)?.resume(returning: available)
            }
        }
        func fail() {
            for key in Array(continuations.keys) { continuations.removeValue(forKey: key)?.resume(throwing: DictationError.network) }
        }
    }
    private final class Host {
        var text = "Existing task"
        var date = Date(timeIntervalSince1970: 100)
    }
    private func settle() async { for _ in 0..<80 { await Task.yield() } }
    private func engine(capture: Capture, whisper: Bool = true,
        appleSupported: Bool = true, probe: (@Sendable () async throws -> Bool)? = nil,
        probeTimeout: TimeInterval = 12, appleStartupTimeout: TimeInterval = 8,
        capabilities: (@Sendable (String) async -> AppleSpeechCapabilities)? = nil,
        factory: @escaping @MainActor (String, @escaping (String, Bool) -> Void, @escaping () -> Void) async throws -> any AppleLiveSpeech) throws -> IOSDictationEngine {
        let launch = try IOSLaunchEnvironment(configuration: .init(isIsolated: true))
        let app = launch.makeModel()
        let (store, model, _, _) = try IOSComposeFixture.make(app: app)
        defer { model.teardown() }
        return IOSDictationEngine(client: store.client, defaults: app.composerDefaults, context: [], services: .init(
            microphone: { true }, authorization: { true },
            capabilities: capabilities ?? { _ in .init(analyzer: false, recognizer: appleSupported, onDevice: true) },
            whisper: probe ?? { whisper }, capture: capture, speech: factory), probeTimeout: probeTimeout, appleStartupTimeout: appleStartupTimeout)
    }
    func testSlowWhisperStatusRecordsImmediatelyAndFinalizesViaWhisper() async throws {
        let capture = Capture()
        let engine = try engine(capture: capture, appleSupported: false, probe: {
            try? await Task.sleep(for: .milliseconds(3200)); return true
        }) { _, _, _ in XCTFail("Apple must not start"); return Speech() }
        engine.probeWhisper(); await settle()
        XCTAssertNil(engine.whisperAvailable)
        let started = Date()
        _ = try await engine.start(locale: "en-US")
        XCTAssertLessThan(Date().timeIntervalSince(started), 1)
        XCTAssertFalse(capture.stopped)
        try capture.emit(); await settle()
        let recording = try await engine.finish()
        XCTAssertEqual(engine.whisperAvailable, true)
        let finalizer = WhisperFinalizer(status: { try await engine.resolvedWhisperAvailability() }, transcribe: { wav, _ in
            XCTAssertGreaterThan(wav.count, 44); return "Whisper"
        })
        let result = await finalizer.finalize(recording, locale: "en-US")
        XCTAssertEqual(result.text, "Whisper")
    }
    func testAudioTapAndAuthorizationCallbacksRunOffMainActor() async throws {
        let pair = AsyncStream<AudioCapture.Event>.makeStream()
        let tap: @Sendable (AVAudioPCMBuffer, AVAudioTime) -> Void = AudioCapture.tapCallback(pair.continuation)
        // Construct borrowed AVFoundation values on the callback thread; only the
        // Sendable callback and the stream continuation cross the actor boundary.
        let copied = await Task.detached { () -> Bool in
            XCTAssertFalse(Thread.isMainThread)
            guard let format = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1),
                  let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 2) else { return false }
            buffer.frameLength = 2; buffer.floatChannelData![0][0] = 0.5
            tap(buffer, AVAudioTime(sampleTime: 0, atRate: 16_000))
            buffer.floatChannelData![0][0] = 0
            return true
        }.value
        XCTAssertTrue(copied)
        var iterator = pair.stream.makeAsyncIterator()
        guard case .audio(let copy) = await iterator.next() else { XCTFail("missing copied packet"); return }
        XCTAssertEqual(copy.buffer.floatChannelData![0][0], 0.5)
        pair.continuation.finish()
        for status in [SFSpeechRecognizerAuthorizationStatus.authorized, .denied] {
            let granted = await withCheckedContinuation { continuation in
                let callback: @Sendable (SFSpeechRecognizerAuthorizationStatus) -> Void = SpeechAuthorization.callback(continuation)
                Task.detached {
                    XCTAssertFalse(Thread.isMainThread); callback(status)
                }
            }
            XCTAssertEqual(granted, status == .authorized)
        }
    }
    func testCancelledStartupCannotCancelOrDisableNextRecording() async throws {
        for failure in [false, true] {
            let capture = Capture(), old = Speech(), current = Speech(), rollover = Speech()
            old.suspend = true
            var count = 0
            let engine = try engine(capture: capture) { _, _, failed in
                count += 1
                let speech = count == 1 ? old : count == 2 ? current : rollover
                speech.failed = failed; return speech
            }
            _ = try await engine.start(locale: "en-US")
            await settle(); XCTAssertNotNil(old.startup)
            XCTAssertFalse(capture.stopped, "Apple startup must never delay capture")
            await engine.cancel()
            _ = try await engine.start(locale: "en-US")
            await settle()
            if failure { old.startup?.resume(throwing: DictationError.recognition) }
            else { old.startup?.resume() }
            old.startup = nil
            await settle()
            old.failed() // A stale recognition callback must also leave the current engine alone.
            try capture.emit(); await settle()
            XCTAssertTrue(old.cancelled); XCTAssertFalse(current.cancelled)
            XCTAssertEqual(current.appended, 1); XCTAssertFalse(capture.stopped)
            try capture.emit(rate: 32_000); await settle()
            XCTAssertEqual(count, 3, "old catch must not disable Apple for the next segment")
            XCTAssertEqual(rollover.appended, 1)
            await engine.cancel()
        }
    }
    func testApplePreviewFailureKeepsWhisperCaptureAndCaptureFailureStillStops() async throws {
        for failAppend in [false, true] {
            let capture = Capture(), speech = Speech()
            var events: [DictationEvent] = []
            let engine = try engine(capture: capture) { _, _, failed in speech.failed = failed; return speech }
            let stream = try await engine.start(locale: "en-US")
            let reader = Task { for await event in stream { events.append(event) } }
            await settle()
            speech.failAppend = failAppend
            if !failAppend { speech.failed() }
            try capture.emit(); await settle()
            XCTAssertTrue(speech.cancelled); XCTAssertFalse(capture.stopped)
            XCTAssertFalse(events.contains { if case .failed = $0 { return true }; return false })
            try capture.emit(); await settle()
            // Hardware failure is still emitted even after the preview is disabled.
            capture.continuation?.yield(.interrupted); await settle()
            XCTAssertTrue(events.contains { if case .interrupted = $0 { return true }; return false })
            let recording = try await engine.finish()
            XCTAssertEqual(recording.clips.count, 1); XCTAssertGreaterThan(recording.clips[0].wav.count, 44)
            XCTAssertTrue(capture.stopped); await reader.value
        }
    }
    func testApplePreviewFailureWithoutWhisperReportsRecognitionError() async throws {
        let capture = Capture(), speech = Speech()
        let engine = try engine(capture: capture, whisper: false) { _, _, failed in speech.failed = failed; return speech }
        let stream = try await engine.start(locale: "en-US")
        await settle(); speech.failed()
        var iterator = stream.makeAsyncIterator()
        var failed = false
        while let event = await iterator.next() {
            if case .failed(.recognition) = event { failed = true; break }
        }
        XCTAssertTrue(failed, "missing recognition error")
        await engine.cancel(); XCTAssertTrue(capture.stopped)
    }
    func testUnknownWhisperBecomesAvailableWhileRecordingAndCacheSurvivesPresses() async throws {
        let capture = Capture(), probe = Probe()
        let engine = try engine(capture: capture, appleSupported: false, probe: { try await probe.status() }) {
            _, _, _ in XCTFail("Apple must not start"); return Speech()
        }
        engine.probeWhisper(); await settle()
        XCTAssertEqual(probe.calls, 1); XCTAssertNil(engine.whisperAvailable)
        _ = try await engine.start(locale: "en-US")
        try capture.emit(); await settle()
        XCTAssertFalse(capture.stopped); XCTAssertNil(engine.whisperAvailable)
        probe.resolve(true); await settle()
        XCTAssertEqual(engine.whisperAvailable, true)
        let recording = try await engine.finish()
        XCTAssertEqual(recording.clips.count, 1)
        for _ in 0..<2 {
            _ = try await engine.start(locale: "en-US")
            try capture.emit(); await settle()
            _ = try await engine.finish()
        }
        _ = try await engine.start(locale: "en-US"); await engine.cancel()
        engine.probeWhisper(); await settle()
        XCTAssertEqual(probe.calls, 1, "one discovery per composer lifetime, including cancellation")
    }
    func testUnknownWhisperUnavailableAtFinalizePreservesComposerAndRecordingState() async throws {
        let capture = Capture(), probe = Probe(), host = Host()
        let engine = try engine(capture: capture, appleSupported: false, probe: { try await probe.status() }) {
            _, _, _ in XCTFail("Apple must not start"); return Speech()
        }
        let controller = DictationController(engine: engine, now: { host.date },
            getText: { host.text }, setText: { host.text = $0 })
        await controller.begin(); await settle()
        XCTAssertEqual(controller.state, .recording); XCTAssertFalse(controller.livePreviewAvailable)
        try capture.emit(); await settle()
        host.date.addTimeInterval(1); controller.tick()
        XCTAssertGreaterThan(controller.level, 0); XCTAssertEqual(controller.elapsed, 1)
        controller.release(); await settle()
        XCTAssertEqual(controller.state, .finalizing); XCTAssertTrue(capture.stopped)
        XCTAssertEqual(host.text, "Existing task")
        probe.resolve(false)
        for _ in 0..<10 { await settle() }
        XCTAssertEqual(controller.state, .unsupported)
        XCTAssertEqual(controller.noticeKey, "native_compose_voice_unsupported")
        XCTAssertEqual(host.text, "Existing task"); XCTAssertFalse(controller.active)
        host.text += " typed"; XCTAssertEqual(host.text, "Existing task typed")
        controller.teardown()
    }
    func testProbeFailureAndTimeoutStayUnknownUntilBoundedFinalize() async throws {
        for timeout in [false, true] {
            let capture = Capture(), probe = Probe()
            probe.alwaysFail = !timeout
            let engine = try engine(capture: capture, appleSupported: false, probe: {
                try await probe.status()
            }, probeTimeout: 0.03) { _, _, _ in XCTFail("Apple must not start"); return Speech() }
            engine.probeWhisper()
            try await Task.sleep(for: .milliseconds(60))
            XCTAssertNil(engine.whisperAvailable, "failed background discovery remains unknown")
            _ = try await engine.start(locale: "en-US")
            XCTAssertFalse(capture.stopped)
            try capture.emit(); await settle()
            let started = Date(), recording = try await engine.finish()
            XCTAssertLessThan(Date().timeIntervalSince(started), 0.5)
            XCTAssertEqual(recording.finalizationError, .network)
            XCTAssertEqual(probe.calls, 3, "appearance, press, and exactly one finalize retry")
            XCTAssertEqual(recording.clips.count, 1); XCTAssertGreaterThan(recording.clips[0].wav.count, 44)
            XCTAssertNil(engine.whisperAvailable); XCTAssertTrue(capture.stopped)
            if timeout { probe.resolve(true); await settle(); XCTAssertEqual(engine.whisperAvailable, true) }
            await engine.cancel(); engine.stopWhisperProbe()
        }
    }
    func testTransientProbeFailureRecoversOnNextPressAndAtFinalize() async throws {
        for nextPress in [false, true] {
            let capture = Capture(), probe = Probe()
            probe.failFirst = true
            let engine = try engine(capture: capture, appleSupported: false, probe: { try await probe.status() }) {
                _, _, _ in XCTFail("Apple must not start"); return Speech()
            }
            _ = try await engine.start(locale: "en-US"); await settle()
            XCTAssertNil(engine.whisperAvailable); XCTAssertEqual(probe.calls, 1)
            if nextPress {
                await engine.cancel(); _ = try await engine.start(locale: "en-US"); await settle()
                XCTAssertEqual(probe.calls, 2)
            }
            try capture.emit(); await settle()
            let finishing = Task { try await engine.finish() }
            await settle(); XCTAssertEqual(probe.calls, 2)
            probe.resolve(true)
            let recording = try await finishing.value
            XCTAssertEqual(engine.whisperAvailable, true); XCTAssertNil(recording.finalizationError)
            let finalizer = WhisperFinalizer(status: { try await engine.resolvedWhisperAvailability() }, transcribe: { wav, _ in
                XCTAssertGreaterThan(wav.count, 44); return "Recovered Whisper"
            })
            let result = await finalizer.finalize(recording, locale: "en-US")
            XCTAssertEqual(result.text, "Recovered Whisper"); XCTAssertEqual(probe.calls, 2)
        }
    }
    func testFinalizeRetriesTransientInFlightProbeFailure() async throws {
        let capture = Capture(), probe = Probe()
        let engine = try engine(capture: capture, appleSupported: false, probe: { try await probe.status() }) {
            _, _, _ in XCTFail("Apple must not start"); return Speech()
        }
        _ = try await engine.start(locale: "en-US"); try capture.emit(); await settle()
        let finishing = Task { try await engine.finish() }; await settle()
        probe.fail(); await settle(); XCTAssertEqual(probe.calls, 2)
        probe.resolve(true)
        let recording = try await finishing.value
        XCTAssertNil(recording.finalizationError); XCTAssertEqual(engine.whisperAvailable, true)
    }
    func testStoppedWhisperProbeCanRestartAndIgnoresStoppedAnswer() async throws {
        let capture = Capture(), probe = Probe()
        let engine = try engine(capture: capture, probe: { try await probe.status() }) { _, _, _ in Speech() }
        engine.probeWhisper(); await settle(); engine.stopWhisperProbe()
        engine.probeWhisper(); await settle(); XCTAssertEqual(probe.calls, 2)
        probe.resolve(true, call: 1); await settle(); XCTAssertNil(engine.whisperAvailable)
        probe.resolve(false, call: 2); await settle(); XCTAssertEqual(engine.whisperAvailable, false)
    }
    func testReleaseWaitsForAppleStartupAndReplaysCapturedAudio() async throws {
        let capture = Capture(), speech = Speech()
        speech.suspend = true
        let engine = try engine(capture: capture, whisper: false, appleStartupTimeout: 0.5) { _, _, _ in speech }
        _ = try await engine.start(locale: "en-US"); await settle()
        XCTAssertEqual(engine.whisperAvailable, false); XCTAssertNotNil(speech.startup)
        try capture.emit(); await settle()
        var finished = false
        let finishing = Task { let recording = try await engine.finish(); finished = true; return recording }
        await settle(); XCTAssertTrue(capture.stopped); XCTAssertFalse(finished); XCTAssertFalse(speech.cancelled)
        speech.startup?.resume(); speech.startup = nil
        let recording = try await finishing.value
        XCTAssertEqual(speech.appended, 1, "startup must receive the audio captured before release")
        XCTAssertEqual(recording.appleText, "Apple"); XCTAssertNil(recording.finalizationError)
        XCTAssertEqual(recording.clips.count, 1)
    }
    func testAppleStartupAcrossRolloverRebindsPreviewToCurrentClip() async throws {
        let capture = Capture(), old = Speech(), current = Speech()
        old.suspend = true
        var count = 0
        let engine = try engine(capture: capture, whisper: false) { _, _, _ in
            count += 1; return count == 1 ? old : current
        }
        _ = try await engine.start(locale: "en-US"); await settle()
        try capture.emit(); try capture.emit(rate: 32_000); await settle()
        XCTAssertEqual(count, 1, "rollover must not race the original startup")
        old.startup?.resume(); old.startup = nil; await settle()
        let recording = try await engine.finish()
        XCTAssertTrue(old.cancelled); XCTAssertEqual(current.appended, 1)
        XCTAssertEqual(recording.appleText, "Apple"); XCTAssertEqual(recording.clips.map(\.appleText), ["", "Apple"])
        let finalizer = WhisperFinalizer(status: { false }, transcribe: { _, _ in XCTFail("must not upload"); return "" })
        let result = await finalizer.finalize(recording, locale: "en-US")
        XCTAssertEqual(result.text, "Apple"); XCTAssertEqual(result.missingClips, [0], "earlier audio without text must be reported")
    }
    func testReleaseDuringAppleStartupTimeoutReportsRetryableError() async throws {
        for beforeCapabilityCheck in [false, true] {
            let capture = Capture(), speech = Speech(), gate = Probe()
            speech.suspend = !beforeCapabilityCheck
            let engine = try engine(capture: capture, whisper: false, appleStartupTimeout: 0.03,
                capabilities: { _ in
                    if beforeCapabilityCheck { _ = try? await gate.status() }
                    return .init(analyzer: false, recognizer: true, onDevice: true)
                }) { _, _, _ in speech }
            _ = try await engine.start(locale: "en-US"); try capture.emit(); await settle()
            let started = Date()
            do { _ = try await engine.finish(); XCTFail("missing retryable startup error") }
            catch { XCTAssertEqual(error as? DictationError, .recognition) }
            XCTAssertLessThan(Date().timeIntervalSince(started), 0.5); XCTAssertTrue(capture.stopped)
            speech.startup?.resume(); speech.startup = nil; gate.resolve(true); await settle()
            XCTAssertEqual(engine.appleState, .failed)
            await engine.cancel()
        }
    }
    func testRecordingHintsShowPreparingAndRemainTruthfulAcrossPresses() async throws {
        let capture = Capture(), speech = Speech()
        speech.suspend = true
        let engine = try engine(capture: capture, whisper: false) { _, _, _ in speech }
        let host = Host()
        let controller = DictationController(engine: engine, now: { host.date }, getText: { host.text }, setText: { host.text = $0 })
        await controller.begin(); await settle()
        XCTAssertEqual(controller.state, .recording); XCTAssertTrue(controller.preparing)
        XCTAssertEqual(engine.recordingHintKey.description, "native_compose_voice_preparing")
        let dock = MicDock(voice: controller, audioEngine: engine, attachment: { EmptyView() }, submit: { EmptyView() })
        XCTAssertEqual(dock.hintKey.description, "native_compose_voice_preparing")
        speech.startup?.resume(); speech.startup = nil; await settle()
        XCTAssertFalse(controller.preparing); XCTAssertEqual(engine.recordingHintKey.description, "native_compose_voice_no_send")
        controller.cancel(); await controller.begin()
        XCTAssertEqual(engine.recordingHintKey.description, "native_compose_voice_no_send", "cached Apple capability avoids per-press hint flicker")
        controller.teardown(); await settle()
        let unsupported = try self.engine(capture: Capture(), whisper: false, appleSupported: false) { _, _, _ in Speech() }
        _ = try await unsupported.start(locale: "en-US"); await settle()
        XCTAssertEqual(unsupported.recordingHintKey.description, "native_compose_voice_unsupported")
        await unsupported.cancel()
        let unknown = try self.engine(capture: Capture(), appleSupported: false, probe: { throw DictationError.network }) { _, _, _ in Speech() }
        _ = try await unknown.start(locale: "en-US"); await settle()
        XCTAssertEqual(unknown.recordingHintKey.description, "native_compose_voice_recording")
        await unknown.cancel()
    }
    func testUnknownWhisperKeepsAppleFinalTextWithRetryableNotice() async throws {
        let capture = Capture(), speech = Speech(), host = Host()
        let engine = try engine(capture: capture, probe: { throw DictationError.network }, probeTimeout: 0.03) { _, _, _ in speech }
        let controller = DictationController(engine: engine, now: { host.date }, getText: { host.text }, setText: { host.text = $0 })
        await controller.begin(); await settle(); try capture.emit(); await settle()
        host.date.addTimeInterval(1); controller.release()
        for _ in 0..<10 { await settle() }
        XCTAssertEqual(controller.state, .error); XCTAssertEqual(controller.noticeKey, "native_compose_voice_error")
        XCTAssertEqual(host.text, "Existing task Apple"); XCTAssertNil(engine.whisperAvailable)
        controller.teardown()
    }
    func testWhisperFinalTextReplacesUsableApplePreview() async throws {
        let capture = Capture(), speech = Speech()
        let engine = try engine(capture: capture) { _, _, _ in speech }
        _ = try await engine.start(locale: "en-US"); await settle()
        try capture.emit(); await settle()
        let recording = try await engine.finish()
        XCTAssertEqual(recording.appleText, "Apple")
        let finalizer = WhisperFinalizer(status: { try await engine.resolvedWhisperAvailability() }, transcribe: { _, _ in "Whisper" })
        let result = await finalizer.finalize(recording, locale: "en-US")
        XCTAssertEqual(result.text, "Whisper", "Whisper remains final when Apple works (preferLocal design)")
    }

}
