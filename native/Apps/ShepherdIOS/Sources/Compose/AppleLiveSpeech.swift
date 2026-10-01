import AVFoundation
import Speech
import ShepherdAppCore

@MainActor protocol AppleLiveSpeech: AnyObject {
    func start() async throws
    func append(_ buffer: AVAudioPCMBuffer) throws
    func finish() async -> String
    func cancel()
}

@MainActor final class SFSpeechEngine: AppleLiveSpeech {
    private let recognizer: SFSpeechRecognizer
    private let onDevice: Bool
    private let contextualStrings: [String]
    private let update: (String, Bool) -> Void
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var text = ""
    private var settled = false
    private var completed = ""
    private var finishing = false
    private var requestID = 0
    private let failed: () -> Void
    init(recognizer: SFSpeechRecognizer, onDevice: Bool, contextualStrings: [String], failed: @escaping () -> Void, update: @escaping (String, Bool) -> Void) {
        self.recognizer = recognizer; self.onDevice = onDevice; self.contextualStrings = contextualStrings; self.update = update; self.failed = failed
    }
    func start() async throws { beginRequest() }
    private func beginRequest() {
        requestID += 1; let mine = requestID
        settled = false
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true; request.addsPunctuation = true
        request.requiresOnDeviceRecognition = onDevice; request.contextualStrings = contextualStrings
        self.request = request
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            // Extract immutable Sendable values before crossing the actor boundary.
            let value = result?.bestTranscription.formattedString, final = result?.isFinal ?? false, failed = error != nil
            Task { @MainActor [weak self] in
                guard let self, self.request != nil, requestID == mine else { return }
                if let value { text = DictationController.append(completed, value); update(text, final) }
                if final || failed {
                    settled = true
                    if !finishing {
                        completed = text
                        if failed { self.failed() }
                        else { task?.cancel(); beginRequest() }
                    }
                }
            }
        }
    }
    func append(_ buffer: AVAudioPCMBuffer) throws { request?.append(buffer) }
    func finish() async -> String {
        finishing = true
        request?.endAudio()
        // Recognition can fail without a final callback. Retain the latest partial and bound wait.
        for _ in 0..<20 where !settled {
            if Task.isCancelled { break }
            try? await Task.sleep(for: .milliseconds(50))
        }
        let result = text; cancel(); return result
    }
    func cancel() { requestID += 1; request = nil; task?.cancel(); task = nil }
}

@available(iOS 26, *) @MainActor final class SpeechAnalyzerEngine: AppleLiveSpeech {
    private let transcriber: SpeechTranscriber
    private var analyzer: SpeechAnalyzer?
    private var continuation: AsyncStream<AnalyzerInput>.Continuation?
    private var resultsTask: Task<Void, Never>?
    private var format: AVAudioFormat?
    private var converter: AVAudioConverter?
    private var stable = "", volatile = ""
    private let update: (String, Bool) -> Void
    private let preparing: () -> Void
    init(locale: Locale, preparing: @escaping () -> Void, update: @escaping (String, Bool) -> Void) {
        transcriber = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
        self.preparing = preparing; self.update = update
    }
    func start() async throws {
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            preparing(); try await request.downloadAndInstall()
        }
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else { throw DictationError.unsupported }
        self.format = format
        let pair = AsyncStream<AnalyzerInput>.makeStream()
        continuation = pair.continuation
        let analyzer = SpeechAnalyzer(modules: [transcriber]); self.analyzer = analyzer
        resultsTask = Task { [weak self] in
            guard let self else { return }
            do {
                for try await result in transcriber.results {
                    guard !Task.isCancelled else { return }
                    let text = String(result.text.characters)
                    if result.isFinal { stable = DictationController.append(stable, text); volatile = "" }
                    else { volatile = text }
                    update(DictationController.append(stable, volatile), result.isFinal)
                }
            } catch { /* Latest text remains the offline fallback. */ }
        }
        try await analyzer.prepareToAnalyze(in: format)
        try await analyzer.start(inputSequence: pair.stream)
    }
    func append(_ buffer: AVAudioPCMBuffer) throws {
        guard let format else { return }
        if buffer.format == format { continuation?.yield(AnalyzerInput(buffer: buffer)); return }
        if converter?.inputFormat != buffer.format { converter = AVAudioConverter(from: buffer.format, to: format) }
        guard let converter,
              let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(ceil(Double(buffer.frameLength) * format.sampleRate / buffer.format.sampleRate) + 64)) else { throw DictationError.audio }
        var supplied = false, error: NSError?
        converter.convert(to: converted, error: &error) { _, status in
            if supplied { status.pointee = .noDataNow; return nil }
            supplied = true; status.pointee = .haveData; return buffer
        }
        if error != nil { throw DictationError.audio }
        if converted.frameLength > 0 { continuation?.yield(AnalyzerInput(buffer: converted)) }
    }
    func finish() async -> String {
        continuation?.finish(); continuation = nil
        try? await analyzer?.finalizeAndFinishThroughEndOfInput()
        await resultsTask?.value
        let result = DictationController.append(stable, volatile); cancel(); return result
    }
    func cancel() {
        continuation?.finish(); continuation = nil; resultsTask?.cancel(); resultsTask = nil
        if let analyzer { Task { await analyzer.cancelAndFinishNow() } }
        analyzer = nil; converter = nil
    }
}
