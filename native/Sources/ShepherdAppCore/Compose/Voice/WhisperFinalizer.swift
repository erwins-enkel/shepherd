import Foundation
import ShepherdKit

/// Optional server final text with per-clip Apple fallback. No disposable preview uploads.
@MainActor public final class WhisperFinalizer: DictationFinalizer {
    private let status: @Sendable () async throws -> Bool
    private let transcribe: @Sendable (Data, String) async throws -> String
    public init(client: ShepherdClient) {
        status = { try await client.getVoiceStatus()?.available == true }
        transcribe = { try await client.transcribeAudio($0, language: $1) }
    }
    public init(status: @escaping @Sendable () async throws -> Bool,
                transcribe: @escaping @Sendable (Data, String) async throws -> String) {
        self.status = status; self.transcribe = transcribe
    }
    public func finalize(_ recording: DictationRecording, locale: String) async -> String {
        guard !recording.clips.isEmpty, (try? await status()) == true, !Task.isCancelled else { return recording.appleText }
        var parts: [String] = []
        for clip in recording.clips {
            guard !Task.isCancelled else { return recording.appleText }
            let text = try? await transcribe(clip.wav, locale.hasPrefix("de") ? "de" : "en")
            parts.append(text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? text! : clip.appleText)
        }
        let text = parts.filter { !$0.isEmpty }.joined(separator: " ")
        return text.isEmpty ? recording.appleText : text
    }
}
