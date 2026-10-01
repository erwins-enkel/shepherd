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
    enum AppleState { case unknown, starting, preparing, ready, unavailable, failed }
    private(set) var appleState: AppleState = .unknown
    // Only definitive answers survive across recording presses.
    private(set) var whisperAvailable: Bool?
    private var whisperProbe: Task<Bool?, Never>?
    private var appleStartup: Task<Void, Never>?
    private var probeGeneration = 0
    private var probeID = 0
    private var appleError: DictationError = .recognition
    private let appleStartupTimeout: TimeInterval
    private let probeTimeout: TimeInterval
    private var lastLevel = Date.distantPast
    init(client: ShepherdClient, defaults: UserDefaults, context: [String], services: IOSDictationServices? = nil, probeTimeout: TimeInterval = 12, appleStartupTimeout: TimeInterval = 8) {
        self.services = services ?? .live(client: client); self.defaults = defaults; self.context = context; self.probeTimeout = probeTimeout; self.appleStartupTimeout = appleStartupTimeout
    }

    /// Composer appearance and later presses retry unknown status; definitive answers are cached.
    func probeWhisper() {
        guard whisperAvailable == nil, whisperProbe == nil else { return }
        probeID += 1
        let id = probeID, mine = probeGeneration, status = services.whisper, timeout = probeTimeout
        whisperProbe = Task { [weak self] in
            let result = await DictationDeadline.value(seconds: timeout) { [weak self] in
                let answer = try? await status()
                // The deadline cancels its worker, but a transport can still answer later.
                // Cache that answer unless discovery was explicitly stopped.
                await self?.cacheWhisper(answer, mine: mine)
                return answer
            } ?? nil
            if let self, mine == self.probeGeneration, id == self.probeID { self.whisperProbe = nil }
            return result
        }
    }
    private func cacheWhisper(_ answer: Bool?, mine: Int) {
        guard mine == probeGeneration, let answer else { return }
        whisperAvailable = answer
    }
    func resolvedWhisperAvailability() async throws -> Bool {
        if let whisperAvailable { return whisperAvailable }
        // Await any in-flight discovery, then make exactly one bounded finalize retry.
        if let probe = whisperProbe {
            _ = await probe.value
            try Task.checkCancellation()
            if let whisperAvailable { return whisperAvailable }
        }
        probeWhisper()
        if let retry = whisperProbe { _ = await retry.value }
        try Task.checkCancellation()
        if let whisperAvailable { return whisperAvailable }
        throw DictationError.network
    }
    func stopWhisperProbe() {
        probeGeneration += 1; whisperProbe?.cancel(); whisperProbe = nil
    }

    var recordingHintKey: StaticString {
        if preparing { return "native_compose_voice_preparing" }
        if appleState == .ready { return "native_compose_voice_no_send" }
        if whisperAvailable == true { return "native_compose_voice_on_release" }
        if appleState == .unavailable && whisperAvailable == false { return "native_compose_voice_unsupported" }
        if appleState == .failed { return "native_compose_voice_error" }
        return "native_compose_voice_recording"
    }

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
        canUseApple = false; useAppleServer = false; appleError = .recognition
        if appleState != .ready { appleState = .starting }
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
        guard canUseApple else { appleState = appleError == .unsupported ? .unavailable : .failed; return }
        do {
            try await startSpeech(index: segment, mine: mine)
            guard mine == generation, !Task.isCancelled else { return }
        } catch {
            guard mine == generation, !Task.isCancelled else { return }
            appleError = error as? DictationError ?? .recognition
            canUseApple = false; preparing = false; appleState = .failed
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
            try await prepareSpeech(engine, index: index, mine: mine); return
        }
        if #available(iOS 26, *), SpeechTranscriber.isAvailable,
           let supported = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: language)) {
            guard mine == generation, !Task.isCancelled else { throw CancellationError() }
            let engine = SpeechAnalyzerEngine(locale: supported, preparing: { [weak self] in
                guard let self, mine == generation else { return }
                preparing = true; appleState = .preparing; continuation?.yield(.preparing)
            }, failed: failed, update: update)
            do {
                try await prepareSpeech(engine, index: index, mine: mine); return
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
        try await prepareSpeech(engine, index: index, mine: mine)
    }
    private func prepareSpeech(_ engine: any AppleLiveSpeech, index: Int, mine: Int) async throws {
        do {
            guard mine == generation, !Task.isCancelled else { throw CancellationError() }
            preparing = true; appleState = .preparing; continuation?.yield(.preparing)
            try await engine.start()
            guard mine == generation, !Task.isCancelled else { throw CancellationError() }
            guard canUseApple else { engine.cancel(); return }
            // Startup can span a clip rollover. Rebind callbacks before replaying that clip.
            guard index == segment else {
                engine.cancel(); try await startSpeech(index: segment, mine: mine); return
            }
            // Replay the current PCM segment captured during permissions/model startup.
            if !samples.isEmpty {
                guard let format = AVAudioFormat(standardFormatWithSampleRate: inputRate, channels: 1),
                      let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)),
                      let channel = buffer.floatChannelData?[0] else { throw DictationError.audio }
                buffer.frameLength = AVAudioFrameCount(samples.count)
                for (index, sample) in samples.enumerated() { channel[index] = sample }
                try engine.append(buffer)
            }
            speech = engine; preparing = false; appleState = .ready
            continuation?.yield(.livePreview(true))
        } catch {
            // A suspended startup owns only this candidate, never the current shared engine.
            engine.cancel(); throw error
        }
    }
    private func previewFailed(index: Int, mine: Int) {
        guard mine == generation, index == segment else { return }
        canUseApple = false; appleError = .recognition; preparing = false; appleState = .failed; speech?.cancel(); speech = nil
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
            // An outstanding initial startup will attach to the current segment.
            if canUseApple, old != nil {
                do { try await startSpeech(index: segment, mine: mine) }
                catch {
                    guard mine == generation else { return }
                    canUseApple = false; appleError = .recognition; preparing = false; appleState = .failed
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
        capture.stop()
        // Drain copied audio already queued by the tap before ending Apple's input.
        await captureTask?.value
        guard mine == generation, !Task.isCancelled else { throw CancellationError() }
        captureTask = nil
        if let startup = appleStartup {
            let finished = await DictationDeadline.value(seconds: appleStartupTimeout) {
                await startup.value; return true
            } == true
            guard mine == generation, !Task.isCancelled else { throw CancellationError() }
            if !finished {
                startup.cancel(); canUseApple = false; appleError = .recognition
                preparing = false; appleState = .failed
            }
            appleStartup = nil; resolveAppleServerConsent(false)
        }
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
        let appleText = texts.filter { !$0.isEmpty }.joined(separator: " ")
        var available: Bool?, finalizationError: DictationError?
        do { available = try await resolvedWhisperAvailability() }
        catch is CancellationError { throw CancellationError() }
        catch { finalizationError = .network }
        guard mine == generation, !Task.isCancelled else { throw CancellationError() }
        continuation?.finish(); continuation = nil; audioClips = []; samples = []
        if available == false && !canUseApple && appleText.isEmpty { throw appleError }
        return DictationRecording(clips: clips, appleText: appleText, finalizationError: finalizationError)
    }
    func cancel() async {
        generation += 1; appleStartup?.cancel(); appleStartup = nil; preparing = false; resolveAppleServerConsent(false); capture.stop(); captureTask?.cancel(); captureTask = nil
        speech?.cancel(); speech = nil; pendingSpeech.forEach { $0.cancel() }; pendingSpeech = []
        audioClips.forEach { $0.cancel() }; audioClips = []; samples = []; texts = []; continuation?.finish(); continuation = nil
    }
}
