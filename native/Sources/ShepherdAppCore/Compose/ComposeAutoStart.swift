import Foundation
import Observation

/// A start requested while attachments are still uploading. It fires once they settle,
/// unless the operator takes it back or an attachment they chose did not make it.
@Observable @MainActor
public final class ComposeAutoStart {
    public private(set) var armed = false
    /// The last request ended without starting because an upload failed.
    public private(set) var aborted = false
    @ObservationIgnored private let keepAlive: AttachmentModel.KeepAlive?
    @ObservationIgnored private var release: (@MainActor () -> Void)?
    private var generation = 0

    public init(keepAlive: AttachmentModel.KeepAlive? = nil) { self.keepAlive = keepAlive }

    public func arm(force: Bool, attachments: AttachmentModel, fire: @escaping @MainActor (Bool) async -> Void) {
        guard !armed else { return }
        armed = true; aborted = false
        generation += 1
        let mine = generation
        release = keepAlive?()
        let dropped = attachments.droppedImports
        Task { [weak self] in
            await attachments.settled()
            guard let self, mine == generation, armed else { return }
            armed = false
            if attachments.hasFailedUploads || attachments.droppedImports != dropped { aborted = true }
            else { await fire(force) }
            if mine == generation { endKeepAlive() }
        }
    }

    public func disarm() {
        armed = false
        generation += 1
        endKeepAlive()
    }

    /// New upload work makes an earlier abort notice stale.
    public func clearAborted() { aborted = false }

    public func teardown() { disarm() }

    private func endKeepAlive() {
        release?()
        release = nil
    }
}
