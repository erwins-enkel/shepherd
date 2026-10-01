import AVFoundation
import Speech
import ShepherdAppCore
import ShepherdKit

struct AppleSpeechCapabilities: Sendable {
    let analyzer: Bool
    let recognizer: Bool
    let onDevice: Bool
    nonisolated static func detect(locale: String) async -> Self {
        let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale))
        let available = recognizer?.isAvailable == true
        let onDevice = recognizer?.supportsOnDeviceRecognition == true
        var analyzer = false
        if #available(iOS 26, *), SpeechTranscriber.isAvailable {
            analyzer = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: locale)) != nil
        }
        return .init(analyzer: analyzer, recognizer: available, onDevice: onDevice)
    }
}

/// Permission callbacks must never inherit the actor of their caller.
enum SpeechAuthorization {
    nonisolated static func callback(_ continuation: CheckedContinuation<Bool, Never>)
        -> @Sendable (SFSpeechRecognizerAuthorizationStatus) -> Void {
        { @Sendable status in continuation.resume(returning: status == .authorized) }
    }
    nonisolated static func request() async -> Bool {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization(callback(continuation))
        }
    }
}

/// Injectable boundaries let startup races run without microphone or speech services.
@MainActor struct IOSDictationServices {
    var microphone: @Sendable () async -> Bool
    var authorization: @Sendable () async -> Bool
    var capabilities: @Sendable (String) async -> AppleSpeechCapabilities
    var whisper: @Sendable () async -> Bool
    var capture: any DictationAudioCapture
    var speech: (@MainActor (String, @escaping (String, Bool) -> Void, @escaping () -> Void) async throws -> any AppleLiveSpeech)?
    static func live(client: ShepherdClient) -> Self {
        .init(microphone: { await AVAudioApplication.requestRecordPermission() },
              authorization: { await SpeechAuthorization.request() },
              capabilities: { await AppleSpeechCapabilities.detect(locale: $0) },
              whisper: { (try? await client.getVoiceStatus()?.available) == true }, capture: AudioCapture())
    }
}
