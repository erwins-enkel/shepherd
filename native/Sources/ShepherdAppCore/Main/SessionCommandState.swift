import Observation
import SwiftUI
import ShepherdKit

/// The toolbar's busy/error gate for the two session commands, pulled out of
/// the view so it is unit-testable without hosting SwiftUI (pattern:
/// `LoginSheetState`, `FirstRunSubmission`, `NewSessionSubmission`).
///
/// It exists because a command that only logs its failure is a command the
/// operator watches do nothing: archive against a server that refuses it left
/// the row in place with no explanation anywhere they could see.
@Observable
@MainActor
public final class SessionCommandState {
    public init() {}

    public private(set) var busy = false
    public private(set) var message: String?

    public func clear() { message = nil }

    /// Runs `command` unless one is already in flight. `failureCopy` turns the
    /// already-mapped `ShepherdErrorCopy` line into the sentence for this
    /// particular command. `isCurrent` reports whether the store the command
    /// went to is still the active one — a completion for a store the operator
    /// has moved on from touches nothing and is logged at debug.
    /// - Returns: whether the command succeeded *and* is still current, which
    ///   is the only case where the caller may act on it.
    @discardableResult
    public func run(
        _ command: () async throws -> Void,
        failureCopy: (String) -> String,
        isCurrent: () -> Bool
    ) async -> Bool {
        guard !busy else { return false }
        busy = true
        message = nil
        defer { busy = false }
        do {
            try await command()
            return isCurrent()
        } catch {
            if isCurrent() {
                message = failureCopy(ShepherdErrorCopy.message(error))
            } else {
                Log.ui.debug("dropping a stale session-command failure")
            }
            return false
        }
    }
}

/// What a notice is telling the operator. Only the chrome differs — the bar's
/// layout, dismissal and accessibility identifier are the same either way.
///
/// The default everywhere is `.warning`, because that is what every notice in
/// the app was before the action bar arrived: a command failure, or a sign-out
/// whose token revoke did not go through. `.success` exists so the action bar's
/// one-line confirmations ("Stopped TASK-07", "Renamed…") stop reading as
/// something having gone wrong.
///
/// A plain enum with two computed properties rather than a `ViewModifier`, so
/// the mapping is assertable without hosting SwiftUI — `NoticeToneTests`.
public enum NoticeTone: Equatable, Sendable {
    case warning
    case success

    public var systemImage: String {
        switch self {
        case .warning: "exclamationmark.triangle.fill"
        case .success: "checkmark.circle.fill"
        }
    }

    public var tint: Color {
        switch self {
        case .warning: .orange
        case .success: .green
        }
    }
}
