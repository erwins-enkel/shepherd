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
@MainActor final class AudioCapture {
    enum Event: Sendable { case audio(CapturedAudio), interrupted }
    private let engine = AVAudioEngine()
    private var continuation: AsyncStream<Event>.Continuation?
    private var observers: [any NSObjectProtocol] = []
    private var tapped = false
    func start() throws -> AsyncStream<Event> {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .default, options: [.allowBluetooth])
        try session.setActive(true)
        let pair = AsyncStream<Event>.makeStream(bufferingPolicy: .bufferingNewest(64))
        continuation = pair.continuation
        let input = engine.inputNode, format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { stop(); throw DictationError.audio }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            guard let copy = CapturedAudio(buffer) else { pair.continuation.yield(.interrupted); return }
            // Dropped frames mean a broken clip, so stop instead of silently losing words.
            if case .dropped = pair.continuation.yield(.audio(copy)) { pair.continuation.yield(.interrupted) }
        }
        tapped = true
        observers = [AVAudioSession.interruptionNotification, AVAudioSession.routeChangeNotification,
                     Notification.Name.AVAudioEngineConfigurationChange].map { name in
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: nil) { note in
                if name == AVAudioSession.interruptionNotification,
                   note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt != AVAudioSession.InterruptionType.began.rawValue { return }
                // Any route/format change ends this recording safely; never auto-resume.
                pair.continuation.yield(.interrupted)
            }
        }
        do { engine.prepare(); try engine.start() } catch { stop(); throw DictationError.audio }
        return pair.stream
    }
    func stop() {
        engine.stop()
        if tapped { engine.inputNode.removeTap(onBus: 0); tapped = false }
        observers.forEach(NotificationCenter.default.removeObserver); observers = []
        continuation?.finish(); continuation = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
