import AVFoundation
import Observation
import Speech
import ShepherdAppCore
import ShepherdKit

/// One capture tap feeds Apple live speech, the level meter and the PCM WAV encoder.
@Observable @MainActor final class IOSDictationEngine: DictationEngine {
    var needsAppleServerConsent = false
    var preparing = false
    private let client: ShepherdClient
    private let defaults: UserDefaults
    private let context: [String]
    private let capture = AudioCapture()
    private var continuation: AsyncStream<DictationEvent>.Continuation?
    private var consent: AsyncStream<Bool>.Continuation?
    private var captureTask: Task<Void, Never>?
    private var speech: (any AppleLiveSpeech)?
    private var pendingSpeech: [Task<String, Never>] = []
    private var audioClips: [Task<Data, Never>] = []
    private var samples: [Float] = []
    private var inputRate: Double = 16_000
    private var texts: [String] = []
    private var locale = "de-DE"
    private var generation = 0
    private var segment = 0
    private var checkpointIndex = -1
    private var useAppleServer = false
    private var canUseApple = false
    private var whisperAvailable = false
    private var lastLevel = Date.distantPast
    init(client: ShepherdClient, defaults: UserDefaults, context: [String]) { self.client = client; self.defaults = defaults; self.context = context }

    func resolveAppleServerConsent(_ allowed: Bool) {
        if allowed { defaults.set(true, forKey: "shepherd:apple-server-speech-consent") }
        consent?.yield(allowed); consent?.finish(); consent = nil; needsAppleServerConsent = false
    }
    func start(locale: String) async throws -> AsyncStream<DictationEvent> {
        generation += 1; let mine = generation
        self.locale = locale; segment = 0; checkpointIndex = -1; preparing = false; texts = [""]; samples = []; audioClips = []; pendingSpeech = []
        let pair = AsyncStream<DictationEvent>.makeStream(); continuation = pair.continuation
        let mic = await AVAudioApplication.requestRecordPermission()
        guard mine == generation else { throw CancellationError() }
        guard mic else { throw DictationError.denied }
        // Optional plugin availability allows dictation even when Apple speech permission is denied.
        let client = client
        let whisper = await DictationDeadline.value(seconds: 2) { (try? await client.getVoiceStatus()?.available) == true } == true
        guard mine == generation else { throw CancellationError() }
        let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale))
        var analyzerSupported = false
        if #available(iOS 26, *), SpeechTranscriber.isAvailable {
            analyzerSupported = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: locale)) != nil
        }
        let appleSupported = analyzerSupported || recognizer?.isAvailable == true
        let authorized: Bool
        if appleSupported {
            authorized = await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
            }
        } else { authorized = false }
        guard mine == generation else { throw CancellationError() }
        let choice = SpeechEngineChoice.choose(analyzer: analyzerSupported,
            recognizer: recognizer?.isAvailable == true, onDevice: recognizer?.supportsOnDeviceRecognition == true,
            speechGranted: authorized, appleServerConsent: defaults.bool(forKey: "shepherd:apple-server-speech-consent"), whisper: whisper)
        whisperAvailable = whisper
        canUseApple = [.analyzer, .onDevice, .appleServer, .needsConsent].contains(choice)
        useAppleServer = choice == .appleServer || choice == .needsConsent
        if useAppleServer, !defaults.bool(forKey: "shepherd:apple-server-speech-consent") {
            canUseApple = await requestAppleServerConsent()
        }
        guard mine == generation else { throw CancellationError() }
        if !canUseApple && !whisper { throw !appleSupported || authorized ? DictationError.unsupported : DictationError.denied }
        if canUseApple {
            do { try await startSpeech(index: 0, mine: mine) }
            catch { if !whisper { throw error }; canUseApple = false }
        }
        guard mine == generation else { speech?.cancel(); throw CancellationError() }
        let events = try capture.start()
        captureTask = Task { [weak self] in
            for await event in events {
                guard let self, mine == generation, !Task.isCancelled else { return }
                switch event {
                case .interrupted: continuation?.yield(.interrupted)
                case .audio(let packet): await consume(packet.buffer, mine: mine)
                }
            }
        }
        return pair.stream
    }
    private func requestAppleServerConsent() async -> Bool {
        if defaults.bool(forKey: "shepherd:apple-server-speech-consent") { return true }
        let pair = AsyncStream<Bool>.makeStream(); consent = pair.continuation; needsAppleServerConsent = true
        var iterator = pair.stream.makeAsyncIterator()
        return await iterator.next() == true
    }
    private func startSpeech(index: Int, mine: Int) async throws {
        guard mine == generation else { throw CancellationError() }
        let update: (String, Bool) -> Void = { [weak self] text, final in
            guard let self, mine == generation, index < texts.count else { return }
            texts[index] = text
            continuation?.yield(.preview(texts.filter { !$0.isEmpty }.joined(separator: " ")))
            if final { checkpoint(index: index) }
            // Entire completed clips are emitted once at rollover, never repeated cumulative results.
        }
        if #available(iOS 26, *), SpeechTranscriber.isAvailable,
           let supported = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: locale)) {
            let engine = SpeechAnalyzerEngine(locale: supported, preparing: { [weak self] in self?.preparing = true; self?.continuation?.yield(.preparing) }, update: update)
            do {
                try await engine.start()
                guard mine == generation else { engine.cancel(); throw CancellationError() }
                speech = engine; return
            } catch { engine.cancel(); if mine != generation { throw CancellationError() } }
        }
        guard mine == generation else { throw CancellationError() }
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)), recognizer.isAvailable else { throw DictationError.unsupported }
        // Analyzer assets may be unavailable offline. Its SFSpeech fallback must obtain
        // consent independently when that recognizer cannot run on-device.
        if !recognizer.supportsOnDeviceRecognition && !useAppleServer {
            useAppleServer = await requestAppleServerConsent()
            guard mine == generation else { throw CancellationError() }
            guard useAppleServer else { throw DictationError.unsupported }
        }
        let engine = SFSpeechEngine(recognizer: recognizer, onDevice: !useAppleServer, contextualStrings: context, failed: { [weak self] in self?.continuation?.yield(.failed(.recognition)) }, update: update)
        try await engine.start()
        guard mine == generation else { engine.cancel(); throw CancellationError() }
        speech = engine
    }
    private func consume(_ buffer: AVAudioPCMBuffer, mine: Int) async {
        guard let channels = buffer.floatChannelData else { continuation?.yield(.failed(.audio)); return }
        let rate = buffer.format.sampleRate
        // Rollover at 55 seconds leaves room below the plugin's 60-second clip bound.
        if !samples.isEmpty, (Double(samples.count + Int(buffer.frameLength)) / rate > 55 || rate != inputRate) {
            closeAudioClip()
            let old = speech, index = segment
            speech = nil; segment += 1; texts.append("")
            if let old {
                let task = Task { [weak self] in
                    let text = await old.finish()
                    guard let self, mine == generation else { return text }
                    texts[index] = text; checkpoint(index: index); return text
                }
                pendingSpeech.append(task)
            } else { checkpoint(index: index) }
            if canUseApple {
                do { try await startSpeech(index: segment, mine: mine) }
                catch {
                    guard mine == generation else { return }
                    canUseApple = false
                    if !whisperAvailable { continuation?.yield(.failed(.recognition)) }
                }
            }
        }
        guard mine == generation else { return }
        inputRate = rate
        var energy: Float = 0
        for frame in 0..<Int(buffer.frameLength) {
            var sample: Float = 0
            for channel in 0..<Int(buffer.format.channelCount) { sample += channels[channel][frame] }
            sample /= Float(buffer.format.channelCount); samples.append(sample); energy += sample * sample
        }
        if Date().timeIntervalSince(lastLevel) >= 1 / 30 {
            continuation?.yield(.level(min(1, sqrt(energy / Float(max(1, buffer.frameLength))) * 5))); lastLevel = Date()
        }
        do { try speech?.append(buffer) } catch { continuation?.yield(.failed(.audio)) }
    }
    private func checkpoint(index: Int) {
        guard index >= checkpointIndex, index < texts.count else { return }
        checkpointIndex = index
        continuation?.yield(.checkpoint(texts.prefix(index + 1).filter { !$0.isEmpty }.joined(separator: " ")))
    }
    private func closeAudioClip() {
        guard !samples.isEmpty else { return }
        let captured = samples, rate = inputRate
        samples = []
        audioClips.append(Task.detached(priority: .userInitiated) { DictationWAV.encode(captured, inputRate: rate) })
    }
    func finish() async throws -> DictationRecording {
        let mine = generation
        capture.stop()
        // Drain copied audio already queued by the tap before ending Apple's input.
        await captureTask?.value; captureTask = nil
        guard mine == generation else { throw CancellationError() }
        closeAudioClip()
        if let speech {
            let text = await speech.finish()
            guard mine == generation else { throw CancellationError() }
            texts[segment] = text
        }; speech = nil
        for task in pendingSpeech { _ = await task.value }; pendingSpeech = []
        guard mine == generation else { throw CancellationError() }
        var clips: [DictationClip] = []
        for (index, encoding) in audioClips.enumerated() {
            let wav = await encoding.value
            guard mine == generation else { throw CancellationError() }
            clips.append(.init(wav: wav, appleText: texts.indices.contains(index) ? texts[index] : ""))
        }
        let recording = DictationRecording(clips: clips, appleText: texts.filter { !$0.isEmpty }.joined(separator: " "))
        continuation?.finish(); continuation = nil; audioClips = []; samples = []
        return recording
    }
    func cancel() async {
        generation += 1; preparing = false; resolveAppleServerConsent(false); capture.stop(); captureTask?.cancel(); captureTask = nil
        speech?.cancel(); speech = nil; pendingSpeech.forEach { $0.cancel() }; pendingSpeech = []
        audioClips.forEach { $0.cancel() }; audioClips = []; samples = []; texts = []; continuation?.finish(); continuation = nil
    }
}
