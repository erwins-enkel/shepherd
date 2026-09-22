import Observation
import SwiftUI
import ShepherdKit

/// The sheet's busy/dismiss gate and create seam, pulled out of the view so it
/// is unit-testable without hosting SwiftUI (pattern: `LoginSheetState`,
/// `FirstRunSubmission`).
///
/// A class, not a struct, for the same reason `FirstRunSubmission` is one: the
/// view needs `busy` to flip visibly for the duration of the `await`, which a
/// struct's `self` inside an async mutating method cannot do.
@Observable
@MainActor
public final class NewSessionSubmission {
    public init() {}

    /// What the view should do once `submit` returns. Every case that leaves
    /// the sheet open has already written its own line into `message`.
    public enum Outcome: Equatable, Sendable {
        /// Created, and the store the request went to is still the active one:
        /// select this session and close the sheet.
        case created(Session)
        /// The usage hold tripped and the server queued the task instead of
        /// starting it. Nothing is selected; the sheet stays open saying so.
        case held
        /// The create failed; `message` says how.
        case failed
        /// Nothing to do: a create was already in flight, or the completion
        /// belongs to a sheet or a store the operator has moved on from.
        case dropped
    }

    public private(set) var busy = false
    public private(set) var message: String?
    /// Mirrors `LoginSheetState.canDismiss`: while a create is in flight the
    /// sheet's own close affordance must be blocked too, because dismissing
    /// does not cancel the untracked `Task` in `submit()` — a late success
    /// would otherwise select a session in a window whose sheet is gone.
    public var canDismiss: Bool { !busy }

    /// Runs `create(request)` unless one is already in flight (a second call
    /// while `busy` is a no-op). `isCurrent` reports whether the sheet this
    /// submission started for is still the current one over the still-active
    /// store; false means the operator switched profiles or closed the sheet
    /// mid-flight, so the completion touches nothing and is logged at debug.
    @discardableResult
    public func submit(
        _ request: CreateSessionRequest,
        using create: (CreateSessionRequest) async throws -> CreateOutcome,
        isCurrent: () -> Bool
    ) async -> Outcome {
        guard !busy else { return .dropped }
        busy = true
        message = nil
        defer { busy = false }
        do {
            let outcome = try await create(request)
            guard isCurrent() else {
                Log.ui.debug("dropping a stale new-session completion")
                return .dropped
            }
            switch outcome {
            case .created(let session):
                return .created(session)
            case .held:
                message = L.t("native_newsession_held")
                return .held
            }
        } catch {
            guard isCurrent() else {
                Log.ui.debug("dropping a stale new-session failure")
                return .dropped
            }
            message = L.t("newtask_create_failed", ShepherdErrorCopy.message(error))
            return .failed
        }
    }
}

/// The provider picker's value *and* whether it has been settled, in one
/// object so the two cannot drift.
///
/// They used to be two `@State` flags tied together by a `Binding`'s `set` —
/// and SwiftUI calls `set` only when the value actually changes. Re-selecting
/// the provider already on screen therefore left the picker "unsettled", and a
/// `defaultAgentProvider` arriving with a late bootstrap moved it back under
/// the operator. Every interaction settles it now: `choose(_:)` for a value
/// the picker wrote, `touch()` for an interaction that did not move it.
@Observable
@MainActor
public final class ProviderSelection {
    public init() {}

    public private(set) var provider: AgentProvider = .claude
    /// True once the picker has been settled — seeded from settings, moved by
    /// the operator, or merely touched by them. Only an unsettled picker may
    /// still be moved by an arriving default.
    private(set) var isSettled = false

    /// The picker wrote a value. Settles it whether or not the value moved.
    public func choose(_ next: AgentProvider) {
        provider = next
        isSettled = true
    }

    /// The operator interacted with the picker without moving it.
    public func touch() { isSettled = true }

    /// The seed from `GET /api/settings` on appearance.
    public func seed(_ next: AgentProvider) { choose(next) }

    /// A `defaultAgentProvider` arriving with a late bootstrap: it takes effect
    /// while the picker is still unsettled, and does nothing otherwise.
    /// - Returns: whether it was applied.
    @discardableResult
    public func applyArrivingDefault(_ arriving: AgentProvider?) -> Bool {
        guard let next = Self.arrivingProviderDefault(arriving, alreadySeeded: isSettled)
        else { return false }
        choose(next)
        return true
    }
}

extension ProviderSelection {
    public static func arrivingProviderDefault(
        _ arriving: AgentProvider?, alreadySeeded: Bool
    ) -> AgentProvider? {
        guard !alreadySeeded, let arriving else { return nil }
        return arriving
    }

}
