import Foundation
import Observation
import ShepherdKit

/// One session's place in this host's heavy-check slot (#3181), as the web card's slot line shows it.
public enum HeavySlotEntry: Equatable, Sendable {
    /// Holds the slot: the running command, since when (ms epoch) and its memory, when known.
    case holding(command: String, startedAt: Int, rssBytes: Int?)
    /// Waits in line; `pressure` = held back by the memory brake rather than a busy slot.
    case waiting(position: Int, pressure: Bool)

    /// Mirrors `slotFor` in ui/src/lib/session-pulse.ts: holding wins over waiting, a switched-off
    /// slot and an archived session show nothing.
    public static func of(_ snapshot: Components.Schemas.HeavySlotSnapshot?, session: Session) -> HeavySlotEntry? {
        guard let snapshot, snapshot.enabled, session.status.known != .archived else { return nil }
        if let holder = snapshot.holders.first(where: { $0.sessionId == session.id }) {
            return .holding(command: holder.command, startedAt: holder.startedAt, rssBytes: holder.rssBytes)
        }
        if let waiter = snapshot.waiters.first(where: { $0.sessionId == session.id }) {
            return .waiting(position: waiter.position, pressure: waiter.reason == .pressure)
        }
        return nil
    }
}

/// This host's heavy-check slot for the session cards, read every few seconds while a store is live.
@Observable
@MainActor
public final class HeavySlotModel: AppExtension {
    public private(set) var snapshot: Components.Schemas.HeavySlotSnapshot?
    @ObservationIgnored private var poll: Task<Void, Never>?

    public init(store: SessionStore, app: AppModel) {
        let client = store.client
        poll = Task { [weak self] in
            while !Task.isCancelled {
                // A failed read clears the lines rather than leaving a stale place in line.
                let value = try? await client.heavySlot()
                guard !Task.isCancelled else { return }
                self?.snapshot = value
                do { try await Task.sleep(for: .seconds(5)) } catch { return }
            }
        }
    }

    public func entry(for session: Session) -> HeavySlotEntry? {
        HeavySlotEntry.of(snapshot, session: session)
    }

    public func teardown() {
        poll?.cancel()
        poll = nil
    }
}
