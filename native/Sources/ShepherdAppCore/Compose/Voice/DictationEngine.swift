import Foundation

public enum DictationError: Error, Equatable, Sendable {
    case denied, unsupported, recognition, audio, network
}
public enum DictationEvent: Sendable {
    case level(Float), volatile(String), final(String), preview(String), checkpoint(String), interrupted, failed(DictationError), preparing, livePreview(Bool)
}
/// WAV is always 16 kHz mono 16-bit PCM, with clips no longer than 60 s.
public struct DictationClip: Sendable, Equatable {
    public let wav: Data
    public let appleText: String
    public init(wav: Data, appleText: String) { self.wav = wav; self.appleText = appleText }
}
public struct DictationRecording: Sendable {
    public let clips: [DictationClip]
    public let appleText: String
    /// Retryable capture/finalization failure; any audio-derived Apple text is still usable.
    public let finalizationError: DictationError?
    public init(clips: [DictationClip], appleText: String, finalizationError: DictationError? = nil) {
        self.clips = clips; self.appleText = appleText; self.finalizationError = finalizationError
    }
}
@MainActor public protocol DictationEngine: Sendable {
    func start(locale: String) async throws -> AsyncStream<DictationEvent>
    func finish() async throws -> DictationRecording
    func cancel() async
}
@MainActor public protocol DictationFinalizer: Sendable {
    func finalize(_ recording: DictationRecording, locale: String) async -> DictationFinalization
}
public struct DictationFinalization: Sendable, Equatable {
    public let text: String
    /// Zero-based clip indices for which neither Whisper nor Apple supplied text.
    public let missingClips: [Int]
    public init(text: String, missingClips: [Int] = []) { self.text = text; self.missingClips = missingClips }
}
public enum HoldGesture {
    public enum Intent: Equatable, Sendable { case record, cancel, lock }
    public static func classify(x: Double, y: Double) -> Intent {
        if x <= -80, -x >= -y { return .cancel }
        if y <= -60 { return .lock }
        return .record
    }
}

/// Deterministic engine for core tests, view rendering and isolated accessibility runs.
@MainActor public final class FakeDictationEngine: DictationEngine {
    public var recording = DictationRecording(clips: [], appleText: "")
    public var startError: DictationError?
    public private(set) var cancelled = false
    private var continuation: AsyncStream<DictationEvent>.Continuation?
    public init() {}
    public func start(locale: String) async throws -> AsyncStream<DictationEvent> {
        if let startError { throw startError }
        cancelled = false
        let pair = AsyncStream<DictationEvent>.makeStream()
        continuation = pair.continuation
        return pair.stream
    }
    public func emit(_ event: DictationEvent) { continuation?.yield(event) }
    public func finish() async throws -> DictationRecording { continuation?.finish(); return recording }
    public func cancel() async { cancelled = true; continuation?.finish(); continuation = nil }
}
