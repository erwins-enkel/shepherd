import XCTest
import AVFoundation
import Speech
import ShepherdAppCore
@testable import ShepherdIOS

@MainActor final class IOSDictationTests: XCTestCase {
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
    private func settle() async { for _ in 0..<80 { await Task.yield() } }
    private func engine(capture: Capture, whisper: Bool = true,
        factory: @escaping @MainActor (String, @escaping (String, Bool) -> Void, @escaping () -> Void) async throws -> any AppleLiveSpeech) throws -> IOSDictationEngine {
        let launch = try IOSLaunchEnvironment(configuration: .init(isIsolated: true))
        let app = launch.makeModel()
        let (store, model, _, _) = try IOSComposeFixture.make(app: app)
        defer { model.teardown() }
        return IOSDictationEngine(client: store.client, defaults: app.composerDefaults, context: [], services: .init(
            microphone: { true }, authorization: { true },
            capabilities: { _ in .init(analyzer: false, recognizer: true, onDevice: true) },
            whisper: { whisper }, capture: capture, speech: factory))
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
            let startup = Task { try await engine.start(locale: "en-US") }
            await settle(); XCTAssertNotNil(old.startup)
            await engine.cancel()
            _ = try await engine.start(locale: "en-US")
            if failure { old.startup?.resume(throwing: DictationError.recognition) }
            else { old.startup?.resume() }
            old.startup = nil
            do { _ = try await startup.value; XCTFail("stale startup succeeded") }
            catch { XCTAssertTrue(error is CancellationError) }
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
        speech.failed()
        var iterator = stream.makeAsyncIterator()
        guard case .failed(.recognition) = await iterator.next() else { XCTFail("missing recognition error"); return }
        await engine.cancel(); XCTAssertTrue(capture.stopped)
    }
}
