import ShepherdAppCore

/// AVAudioSession is app-wide, so composer and every terminal share this lease.
@MainActor
final class IOSRecordingLease {
    static let shared = IOSRecordingLease()
    private weak var owner: IOSLeasedDictationEngine?
    private var transfer: Task<Void, Never>?
    private var revision = 0

    func acquire(_ candidate: IOSLeasedDictationEngine) async {
        revision += 1; let mine = revision
        let previous = transfer
        let task = Task { @MainActor in
            await previous?.value
            if let owner = self.owner, owner !== candidate { await owner.relinquish() }
            self.owner = candidate
        }
        transfer = task
        await task.value
        if mine == revision { transfer = nil }
    }

    func owns(_ candidate: IOSLeasedDictationEngine) -> Bool { owner === candidate }
    func release(_ candidate: IOSLeasedDictationEngine) {
        if owns(candidate) { owner = nil }
    }
}

/// A former owner's delayed cancel must never deactivate the new owner's audio.
@MainActor
final class IOSLeasedDictationEngine: DictationEngine {
    private let engine: any DictationEngine
    private let lease: IOSRecordingLease
    weak var voice: DictationController?
    private var revision = 0
    private var released: AsyncStream<Void>.Continuation?

    init(engine: any DictationEngine, lease: IOSRecordingLease = .shared) {
        self.engine = engine; self.lease = lease
    }

    func start(locale: String) async throws -> AsyncStream<DictationEvent> {
        let mine = revision
        await lease.acquire(self)
        guard mine == revision, !Task.isCancelled else {
            lease.release(self); throw CancellationError()
        }
        return try await engine.start(locale: locale)
    }

    func finish() async throws -> DictationRecording {
        guard lease.owns(self) else { throw CancellationError() }
        let mine = revision
        do {
            let result = try await engine.finish()
            if mine == revision { release() }
            return result
        } catch {
            if mine == revision, lease.owns(self) { await engine.cancel(); release() }
            throw error
        }
    }

    func cancel() async {
        revision += 1
        guard lease.owns(self) else { return }
        await engine.cancel()
        release()
    }

    func relinquish() async {
        let (changes, signal) = AsyncStream<Void>.makeStream()
        released = signal
        if voice?.capturing == true { voice?.finalize() }
        else if voice?.state == .finalizing { /* Already stopping capture. */ }
        else { voice?.cancel(); await cancel() }
        if !lease.owns(self) { return }
        for await _ in changes { break }
    }

    private func release() {
        lease.release(self)
        released?.yield(()); released?.finish(); released = nil
    }
}
