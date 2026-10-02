import AVFoundation
import Foundation
import ShepherdAppCore

/// The tap creates an owned copy. Its buffer is immutable after handoff to the main actor;
/// AVAudioEngine's borrowed tap buffer must never escape the realtime callback.
final class CapturedAudio: @unchecked Sendable {
    let buffer: AVAudioPCMBuffer
    init?(_ input: AVAudioPCMBuffer) {
        guard let copy = AVAudioPCMBuffer(pcmFormat: input.format, frameCapacity: input.frameLength) else { return nil }
        copy.frameLength = input.frameLength
        let source = UnsafeMutableAudioBufferListPointer(input.mutableAudioBufferList)
        let target = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
        for i in source.indices {
            guard let from = source[i].mData, let to = target[i].mData else { return nil }
            memcpy(to, from, Int(source[i].mDataByteSize))
        }
        buffer = copy
    }
}
@MainActor protocol DictationAudioCapture {
    func start() throws -> AsyncStream<AudioCapture.Event>
    func stop()
}
@MainActor final class AudioCapture: DictationAudioCapture {
    enum Event: Sendable { case audio(CapturedAudio), interrupted }
    private let engine = AVAudioEngine()
    private var continuation: AsyncStream<Event>.Continuation?
    private var observers: [any NSObjectProtocol] = []
    private var tapped = false
    private var capture = 0
    private var recoveries = 0
    func start() throws -> AsyncStream<Event> {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .default, options: [.allowBluetooth])
        try session.setActive(true)
        let pair = AsyncStream<Event>.makeStream(bufferingPolicy: .bufferingNewest(64))
        continuation = pair.continuation; capture += 1; recoveries = 0
        guard installTap(pair.continuation) else { stop(); throw DictationError.audio }
        // Activating the session posts route changes and an engine configuration change
        // on device. Only real interruptions stop capture; a reconfigured engine resumes.
        let mine = capture
        let recover: @Sendable () -> Void = { [weak self] in
            Task { @MainActor in self?.recover(capture: mine) }
        }
        let center = NotificationCenter.default
        observers = [AVAudioSession.interruptionNotification, AVAudioSession.mediaServicesWereResetNotification].map { name in
            center.addObserver(forName: name, object: nil, queue: nil,
                using: Self.interruptionCallback(name: name, continuation: pair.continuation))
        }
        observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil,
            using: Self.interruptionCallback(name: .AVAudioEngineConfigurationChange,
                                             continuation: pair.continuation, recover: recover)))
        do { engine.prepare(); try engine.start() } catch { stop(); throw DictationError.audio }
        return pair.stream
    }
    private func installTap(_ continuation: AsyncStream<Event>.Continuation) -> Bool {
        if tapped { engine.inputNode.removeTap(onBus: 0); tapped = false }
        let input = engine.inputNode, format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { return false }
        input.installTap(onBus: 0, bufferSize: 1024, format: format, block: Self.tapCallback(continuation))
        tapped = true
        return true
    }
    /// The engine stops itself after an I/O change. Reinstall the tap at the new hardware
    /// format and resume; only a capture that cannot resume reports an interruption.
    private func recover(capture mine: Int) {
        guard mine == capture, let continuation, !engine.isRunning else { return }
        recoveries += 1
        guard recoveries <= 3, installTap(continuation) else { continuation.yield(.interrupted); return }
        do { engine.prepare(); try engine.start() } catch { continuation.yield(.interrupted) }
    }
    /// Built outside actor isolation; AVAudioEngine invokes this on its realtime thread.
    nonisolated static func tapCallback(_ continuation: AsyncStream<Event>.Continuation)
        -> @Sendable (AVAudioPCMBuffer, AVAudioTime) -> Void {
        { @Sendable buffer, _ in
            guard let copy = CapturedAudio(buffer) else { continuation.yield(.interrupted); return }
            // Dropped frames mean a broken clip, so stop instead of silently losing words.
            if case .dropped = continuation.yield(.audio(copy)) { continuation.yield(.interrupted) }
        }
    }
    /// Route changes (category change, override, new or lost device) are deliberately not
    /// interruptions: starting capture causes them, and a real input change also posts an
    /// engine configuration change, which `recover` handles.
    nonisolated static func interruptionCallback(name: Notification.Name,
        continuation: AsyncStream<Event>.Continuation,
        recover: @escaping @Sendable () -> Void = {}) -> @Sendable (Notification) -> Void {
        { @Sendable note in
            switch name {
            case AVAudioSession.interruptionNotification:
                if note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt == AVAudioSession.InterruptionType.began.rawValue {
                    continuation.yield(.interrupted)
                }
            case AVAudioSession.mediaServicesWereResetNotification: continuation.yield(.interrupted)
            case .AVAudioEngineConfigurationChange: recover()
            default: break
            }
        }
    }
    func stop() {
        capture += 1
        engine.stop()
        if tapped { engine.inputNode.removeTap(onBus: 0); tapped = false }
        observers.forEach(NotificationCenter.default.removeObserver); observers = []
        continuation?.finish(); continuation = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
