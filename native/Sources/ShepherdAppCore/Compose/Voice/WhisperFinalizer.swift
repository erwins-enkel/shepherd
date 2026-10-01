import Foundation
import ShepherdKit

/// Optional server final text with per-clip Apple fallback. No disposable preview uploads.
@MainActor public final class WhisperFinalizer: DictationFinalizer {
    private let status: @Sendable () async throws -> Bool
    private let transcribe: @Sendable (Data, String) async throws -> String
    private let requestTimeout: TimeInterval
    public init(client: ShepherdClient, requestTimeout: TimeInterval = 25) {
        self.requestTimeout = requestTimeout
        status = { try await client.getVoiceStatus()?.available == true }
        transcribe = { try await client.transcribeAudio($0, language: $1) }
    }
    public init(status: @escaping @Sendable () async throws -> Bool,
                requestTimeout: TimeInterval = 25,
                transcribe: @escaping @Sendable (Data, String) async throws -> String) {
        self.status = status; self.transcribe = transcribe; self.requestTimeout = requestTimeout
    }
    public func finalize(_ recording: DictationRecording, locale: String) async -> DictationFinalization {
        guard !recording.clips.isEmpty else { return .init(text: recording.appleText) }
        let status = status, transcribe = transcribe
        let available = await DictationDeadline.value(seconds: 2) { (try? await status()) == true } == true
        var parts: [String] = []
        var missing: [Int] = []
        let language = locale.hasPrefix("de") ? "de" : "en"
        for (index, clip) in recording.clips.enumerated() {
            var text = ""
            if available, !Task.isCancelled {
                text = await DictationDeadline.value(seconds: requestTimeout) {
                    (try? await transcribe(clip.wav, language)) ?? ""
                } ?? ""
            }
            text = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty { text = clip.appleText.trimmingCharacters(in: .whitespacesAndNewlines) }
            if text.isEmpty { missing.append(index) }
            else { parts.append(text) }
        }
        return .init(text: parts.joined(separator: " "), missingClips: missing)
    }
}
