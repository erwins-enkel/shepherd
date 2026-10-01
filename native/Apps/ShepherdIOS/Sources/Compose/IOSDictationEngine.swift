import AVFoundation
import Observation
import Speech
import ShepherdAppCore
import ShepherdKit

/// One capture tap feeds Apple live speech, the level meter and the PCM WAV encoder.
@Observable @MainActor final class IOSDictationEngine: DictationEngine {
    var needsAppleServerConsent = false
    var preparing = false
    private let services: IOSDictationServices
    private let defaults: UserDefaults
    private let context: [String]
    private var capture: any DictationAudioCapture { services.capture }
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
    // nil remains unknown after a failed background probe until finalize resolves it.
    private(set) var whisperAvailable: Bool?
    private var whisperProbe: Task<Bool?, Never>?
    private var appleStartup: Task<Void, Never>?
    private var appleError: DictationError = .unsupported
    private let probeTimeout: TimeInterval
    private var lastLevel = Date.distantPast
    init(client: ShepherdClient, defaults: UserDefaults, context: [String], services: IOSDictationServices? = nil, probeTimeout: TimeInterval = 12) {
        self.services = services ?? .live(client: client); self.defaults = defaults; self.context = context; self.probeTimeout = probeTimeout
    }

    /// Called on composer appearance. Recording presses reuse this one lifetime probe.
    func probeWhisper() {
        guard whisperProbe == nil else { return }
        let status = services.whisper, timeout = probeTimeout
        whisperProbe = Task { [weak self] in
            let result = await DictationDeadline.value(seconds: timeout) { try? await status() } ?? nil
            guard !Task.isCancelled else { return nil }
            if let result { self?.whisperAvailable = result }
            return result
        }
    }
    func resolvedWhisperAvailability() async -> Bool {
        if let whisperAvailable { return whisperAvailable }
        probeWhisper()
        let probe = whisperProbe!, timeout = probeTimeout
        let result = await DictationDeadline.value(seconds: timeout) { await probe.value } ?? nil
        guard !Task.isCancelled else { return false }
        whisperAvailable = result ?? false
        return whisperAvailable == true
    }
    func stopWhisperProbe() { whisperProbe?.cancel() }

    func resolveAppleServerConsent(_ allowed: Bool) {
        if allowed { defaults.set(true, forKey: "shepherd:apple-server-speech-consent") }
        consent?.yield(allowed); consent?.finish(); consent = nil; needsAppleServerConsent = false
    }
    func start(locale: String) async throws -> AsyncStream<DictationEvent> {
        generation += 1; let mine = generation
        self.locale = locale; segment = 0; checkpointIndex = -1; preparing = false; texts = [""]; samples = []; audioClips = []; pendingSpeech = []
        let pair = AsyncStream<DictationEvent>.makeStream(); continuation = pair.continuation
        let mic = await services.microphone()
        guard mine == generation, !Task.isCancelled else { throw CancellationError() }
        guard mic else { throw DictationError.denied }
        probeWhisper()
        canUseApple = false; useAppleServer = false; appleError = .unsupported
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
        // Apple is a disposable live preview; capture and the recording UI already run.
        appleStartup = Task { [weak self] in
            guard let self else { return }
            await startApplePreview(locale: locale, mine: mine)
        }
        return pair.stream
    }
    private func startApplePreview(locale: String, mine: Int) async {
        let capabilities = await services.capabilities(locale)
        guard mine == generation, !Task.isCancelled else { return }
        let appleSupported = capabilities.analyzer || capabilities.recognizer
        let authorized = appleSupported ? await services.authorization() : false
        guard mine == generation, !Task.isCancelled else { return }
        appleError = appleSupported && !authorized ? .denied : .unsupported
        let choice = SpeechEngineChoice.choose(analyzer: capabilities.analyzer,
            recognizer: capabilities.recognizer, onDevice: capabilities.onDevice,
            speechGranted: authorized, appleServerConsent: defaults.bool(forKey: "shepherd:apple-server-speech-consent"), whisper: whisperAvailable == true)
        canUseApple = [.analyzer, .onDevice, .appleServer, .needsConsent].contains(choice)
        useAppleServer = choice == .appleServer || choice == .needsConsent
        if useAppleServer, !defaults.bool(forKey: "shepherd:apple-server-speech-consent") {
            let allowed = await requestAppleServerConsent()
            guard mine == generation, !Task.isCancelled else { return }
            canUseApple = allowed
        }
        guard canUseApple else { return }
        do {
            try await startSpeech(index: segment, mine: mine)
            guard mine == generation, !Task.isCancelled else { return }
            continuation?.yield(.livePreview(true))
        } catch {
            guard mine == generation, !Task.isCancelled else { return }
            appleError = error as? DictationError ?? .recognition
            canUseApple = false
            continuation?.yield(.livePreview(false))
        }
    }
    private func requestAppleServerConsent() async -> Bool {
        if defaults.bool(forKey: "shepherd:apple-server-speech-consent") { return true }
        let pair = AsyncStream<Bool>.makeStream(); consent = pair.continuation; needsAppleServerConsent = true
        var iterator = pair.stream.makeAsyncIterator()
        return await iterator.next() == true
    }
    private func startSpeech(index: Int, mine: Int) async throws {
        guard mine == generation, !Task.isCancelled else { throw CancellationError() }
        let update: (String, Bool) -> Void = { [weak self] text, final in
            guard let self, mine == generation, index < texts.count else { return }
            texts[index] = text
            continuation?.yield(.preview(texts.filter { !$0.isEmpty }.joined(separator: " ")))
            if final { checkpoint(index: index) }
            // Entire completed clips are emitted once at rollover, never repeated cumulative results.
        }
        let failed: () -> Void = { [weak self] in self?.previewFailed(index: index, mine: mine) }
        let language = locale
        if let factory = services.speech {
            let engine = try await factory(language, update, failed)
            try await prepareSpeech(engine, mine: mine); return
        }
        if #available(iOS 26, *), SpeechTranscriber.isAvailable,
           let supported = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: language)) {
            guard mine == generation, !Task.isCancelled else { throw CancellationError() }
            let engine = SpeechAnalyzerEngine(locale: supported, preparing: { [weak self] in
                guard let self, mine == generation else { return }
                preparing = true; continuation?.yield(.preparing)
            }, failed: failed, update: update)
            do {
                try await prepareSpeech(engine, mine: mine); return
            } catch { if mine != generation { throw CancellationError() } }
        }
        guard mine == generation, !Task.isCancelled else { throw CancellationError() }
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)), recognizer.isAvailable else { throw DictationError.unsupported }
        // Analyzer assets may be unavailable offline. Its SFSpeech fallback must obtain
        // consent independently when that recognizer cannot run on-device.
        if !recognizer.supportsOnDeviceRecognition && !useAppleServer {
            let allowed = await requestAppleServerConsent()
            guard mine == generation, !Task.isCancelled else { throw CancellationError() }
            useAppleServer = allowed
            guard useAppleServer else { throw DictationError.unsupported }
        }
        let engine = SFSpeechEngine(recognizer: recognizer, onDevice: !useAppleServer, contextualStrings: context, failed: failed, update: update)
        try await prepareSpeech(engine, mine: mine)
    }
    private func prepareSpeech(_ engine: any AppleLiveSpeech, mine: Int) async throws {
        do {
            guard mine == generation, !Task.isCancelled else { throw CancellationError() }
            try await engine.start()
            guard mine == generation, !Task.isCancelled else { throw CancellationError() }
            guard canUseApple else { engine.cancel(); return }
            speech = engine
        } catch {
            // A suspended startup owns only this candidate, never the current shared engine.
            engine.cancel(); throw error
        }
    }
    private func previewFailed(index: Int, mine: Int) {
        guard mine == generation, index == segment else { return }
        canUseApple = false; appleError = .recognition; speech?.cancel(); speech = nil
        continuation?.yield(.livePreview(false))
        if whisperAvailable == false { continuation?.yield(.failed(.recognition)) }
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
                    canUseApple = false; appleError = .recognition
                    continuation?.yield(.livePreview(false))
                    if whisperAvailable == false { continuation?.yield(.failed(.recognition)) }
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
        do { try speech?.append(buffer) } catch { previewFailed(index: segment, mine: mine) }
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
        appleStartup?.cancel(); appleStartup = nil; resolveAppleServerConsent(false)
        if speech == nil { canUseApple = false }
        capture.stop()
        // Drain copied audio already queued by the tap before ending Apple's input.
        await captureTask?.value
        guard mine == generation, !Task.isCancelled else { throw CancellationError() }
        captureTask = nil
        closeAudioClip()
        if let speech {
            let text = await speech.finish()
            guard mine == generation, !Task.isCancelled else { throw CancellationError() }
            texts[segment] = text
        }; speech = nil
        for task in pendingSpeech { _ = await task.value }
        guard mine == generation, !Task.isCancelled else { throw CancellationError() }
        pendingSpeech = []
        var clips: [DictationClip] = []
        for (index, encoding) in audioClips.enumerated() {
            let wav = await encoding.value
            guard mine == generation, !Task.isCancelled else { throw CancellationError() }
            clips.append(.init(wav: wav, appleText: texts.indices.contains(index) ? texts[index] : ""))
        }
        let recording = DictationRecording(clips: clips, appleText: texts.filter { !$0.isEmpty }.joined(separator: " "))
        let available = await resolvedWhisperAvailability()
        guard mine == generation, !Task.isCancelled else { throw CancellationError() }
        continuation?.finish(); continuation = nil; audioClips = []; samples = []
        if !available && !canUseApple { throw appleError }
        return recording
    }
    func cancel() async {
        generation += 1; appleStartup?.cancel(); appleStartup = nil; preparing = false; resolveAppleServerConsent(false); capture.stop(); captureTask?.cancel(); captureTask = nil
        speech?.cancel(); speech = nil; pendingSpeech.forEach { $0.cancel() }; pendingSpeech = []
        audioClips.forEach { $0.cancel() }; audioClips = []; samples = []; texts = []; continuation?.finish(); continuation = nil
    }
}
