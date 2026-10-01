import Foundation
import Observation

@Observable @MainActor public final class DictationController {
    public enum State: String, Sendable { case idle, arming, recording, locked, cancelling, finalizing, error, denied, unsupported }
    public private(set) var state: State = .idle
    public private(set) var preview = ""
    public private(set) var level: Float = 0
    public private(set) var elapsed: TimeInterval = 0
    public private(set) var noticeKey: String?
    public var noticeCopy: String? {
        switch noticeKey {
        case "native_compose_voice_denied": L.t("native_compose_voice_denied")
        case "native_compose_voice_unsupported": L.t("native_compose_voice_unsupported")
        case "native_compose_voice_error": L.t("native_compose_voice_error")
        case "native_compose_voice_incomplete": L.t("native_compose_voice_incomplete")
        case "native_compose_voice_interrupted": L.t("native_compose_voice_interrupted")
        case "native_compose_voice_limit": L.t("native_compose_voice_limit")
        default: nil
        }
    }
    public private(set) var preparing = false
    public private(set) var canUndo = false
    public var locale: String { didSet { defaults?.set(locale, forKey: "shepherd:dictation-language") } }
    public var active: Bool { [.arming, .recording, .locked, .cancelling, .finalizing].contains(state) }
    public var capturing: Bool { [.recording, .locked, .cancelling].contains(state) }
    @ObservationIgnored private let engine: any DictationEngine
    @ObservationIgnored private let finalizer: (any DictationFinalizer)?
    @ObservationIgnored private let getText: () -> String
    @ObservationIgnored private let setText: (String) -> Void
    @ObservationIgnored private let now: () -> Date
    @ObservationIgnored private let defaults: UserDefaults?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var timer: Task<Void, Never>?
    @ObservationIgnored private var finishTask: Task<Void, Never>?
    @ObservationIgnored private var cancellationTask: Task<Void, Never>?
    @ObservationIgnored private var undoTask: Task<Void, Never>?
    @ObservationIgnored private var timeoutTask: Task<Void, Never>?
    private var generation = 0
    private var startedAt: Date?
    private var original = ""
    private var lastApplied = ""
    private var stable = ""
    private var undoDeadline: Date?
    public let maximumDuration: TimeInterval
    public let finalizationTimeout: TimeInterval

    public init(engine: any DictationEngine, finalizer: (any DictationFinalizer)? = nil,
                defaults: UserDefaults? = nil, locale: String? = nil,
                maximumDuration: TimeInterval = 300, finalizationTimeout: TimeInterval = 25,
                now: @escaping () -> Date = Date.init,
                getText: @escaping () -> String, setText: @escaping (String) -> Void) {
        self.engine = engine; self.finalizer = finalizer; self.defaults = defaults; self.now = now
        self.getText = getText; self.setText = setText
        self.maximumDuration = maximumDuration; self.finalizationTimeout = finalizationTimeout
        self.locale = locale ?? defaults?.string(forKey: "shepherd:dictation-language")
            ?? (Locale.current.language.languageCode?.identifier == "de" ? "de-DE" : "en-US")
    }
    public func begin(locked: Bool = false) async {
        guard !active else { return }
        await cancellationTask?.value; cancellationTask = nil
        guard !active else { return }
        undoTask?.cancel()
        generation += 1; let mine = generation
        original = getText(); lastApplied = original; stable = ""; preview = ""; elapsed = 0; level = 0
        canUndo = false; noticeKey = nil; preparing = false; state = .arming
        do {
            let events = try await engine.start(locale: locale)
            guard generation == mine else { return }
            state = locked ? .locked : .recording; startedAt = now()
            task = Task { [weak self] in
                for await event in events {
                    guard let self, generation == mine, !Task.isCancelled else { return }
                    receive(event)
                }
            }
            timer = Task { [weak self] in
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
                    guard let self, generation == mine else { return }
                    tick()
                }
            }
        } catch {
            guard generation == mine else { return }
            await engine.cancel()
            let error = error as? DictationError
            state = error == .denied ? .denied : error == .unsupported ? .unsupported : .error
            noticeKey = error == .denied ? "native_compose_voice_denied" : error == .unsupported ? "native_compose_voice_unsupported" : "native_compose_voice_error"
        }
    }
    public func drag(x: Double, y: Double) {
        guard state == .recording || state == .cancelling else { return }
        switch HoldGesture.classify(x: x, y: y) {
        case .lock: state = .locked; persistStable()
        case .cancel: state = .cancelling
        case .record: state = .recording
        }
    }
    public func release() {
        if state == .locked { return }
        if state == .cancelling || state == .arming { cancel() } else if state == .recording { finalize() }
    }
    public func toggle() {
        if capturing { finalize() } else if !active { Task { await begin(locked: true) } }
    }
    private func receive(_ event: DictationEvent) {
        switch event {
        case .level(let value): level = max(0, min(1, value))
        case .volatile(let text): preview = Self.append(stable, text)
        case .preview(let text): preview = text
        case .checkpoint(let text): stable = text; persistStable()
        case .final(let text): stable = Self.append(stable, text); preview = stable; persistStable()
        case .interrupted: noticeKey = "native_compose_voice_interrupted"; finalize()
        case .failed: noticeKey = "native_compose_voice_error"; finalize()
        case .preparing: preparing = true
        }
    }
    private func persistStable() {
        guard state == .locked, !stable.isEmpty, getText() == lastApplied else { return }
        lastApplied = Self.append(original, stable); setText(lastApplied)
    }
    public func tick() {
        if let startedAt, capturing {
            elapsed = max(0, now().timeIntervalSince(startedAt))
            if elapsed >= maximumDuration { noticeKey = "native_compose_voice_limit"; finalize() }
        }
        if let undoDeadline, now() >= undoDeadline { canUndo = false }
    }
    public func finalize() {
        guard capturing else { return }
        elapsed = startedAt.map { max(0, now().timeIntervalSince($0)) } ?? elapsed
        if elapsed < 0.4 { cancel(); return }
        state = .finalizing; timer?.cancel(); level = 0
        let mine = generation, fallback = preview, language = locale
        // Bound capture/Apple shutdown only. The finalizer bounds each server request, so
        // an overall deadline cannot discard successful earlier clips.
        timeoutTask = Task { [weak self] in
            guard let self else { return }
            do { try await Task.sleep(for: .seconds(finalizationTimeout)) } catch { return }
            guard mine == generation, state == .finalizing else { return }
            finishTask?.cancel(); await engine.cancel()
            guard mine == generation, state == .finalizing else { return }
            noticeKey = "native_compose_voice_incomplete"
            complete(preview.isEmpty ? fallback : preview, mine: mine, incomplete: true)
        }
        finishTask = Task { [weak self] in
            guard let self else { return }
            let recording: DictationRecording
            do { recording = try await engine.finish() }
            catch {
                guard mine == generation, !Task.isCancelled else { return }
                noticeKey = "native_compose_voice_error"
                complete(fallback, mine: mine, incomplete: true); return
            }
            guard mine == generation, !Task.isCancelled else { return }
            timeoutTask?.cancel()
            preview = recording.appleText.isEmpty ? fallback : recording.appleText
            let result = await finalizer?.finalize(recording, locale: language) ?? .init(text: preview)
            guard mine == generation, !Task.isCancelled else { return }
            if !result.missingClips.isEmpty { noticeKey = "native_compose_voice_incomplete" }
            complete(result.text, mine: mine, incomplete: !result.missingClips.isEmpty)
        }
    }
    private func complete(_ text: String, mine: Int, incomplete: Bool = false) {
        guard generation == mine else { return }
        timeoutTask?.cancel(); task?.cancel(); generation += 1
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !clean.isEmpty {
            if getText() == lastApplied { lastApplied = Self.append(original, clean) }
            else { original = getText(); lastApplied = Self.append(original, clean) }
            setText(lastApplied); canUndo = true; undoDeadline = now().addingTimeInterval(5)
            let stamp = generation
            undoTask = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(5)) } catch { return }
                guard let self, stamp == generation else { return }
                canUndo = false
            }
        } else { noticeKey = noticeKey ?? "native_compose_voice_error" }
        state = incomplete || clean.isEmpty ? .error : .idle; preview = ""; startedAt = nil; preparing = false
    }
    public func cancel() {
        generation += 1; task?.cancel(); timer?.cancel(); finishTask?.cancel(); timeoutTask?.cancel()
        if active, getText() == lastApplied, lastApplied != original { setText(original) }
        cancellationTask = Task { await engine.cancel() }
        state = .idle; preview = ""; stable = ""; level = 0; startedAt = nil; preparing = false
    }
    public func undo() {
        guard canUndo, let undoDeadline, now() < undoDeadline, getText() == lastApplied else { canUndo = false; return }
        setText(original); canUndo = false
    }
    public func teardown() { cancel(); undoTask?.cancel(); canUndo = false }
    public static func append(_ existing: String, _ text: String) -> String {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return existing }
        return existing + (existing.isEmpty || existing.last?.isWhitespace == true ? "" : " ") + text
    }
}
