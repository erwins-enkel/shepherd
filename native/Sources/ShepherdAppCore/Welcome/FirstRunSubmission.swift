import Observation
import SwiftUI

/// The sheet's busy/dismiss gate and resolve seam, pulled out of the view so
/// it is unit-testable without hosting SwiftUI (see FirstRunSubmissionTests,
/// pattern: `LoginSheetState`). Unlike the login sheet, there is no Cancel
/// button here — first run is mandatory — so this also owns the resolve call
/// itself: the one place that enforces "one resolve in flight" and "a stale
/// completion touches nothing".
///
/// A class, not a struct: the view needs `busy` to flip visibly for the
/// duration of the `await` below, and a struct's `self` inside an async
/// mutating method only writes back to `@State` once the whole method
/// returns, which would hide the in-flight state from SwiftUI entirely.
@Observable
@MainActor
public final class FirstRunSubmission {
    public init() {}

    public private(set) var busy = false
    public private(set) var message: String?
    /// Mirrors `LoginSheetState.canDismiss`: interactive dismissal must stay
    /// blocked while a resolve is in flight, same reasoning as there — there
    /// is no way to cancel the untracked `Task` `submit()` runs in.
    public var canDismiss: Bool { !busy }

    /// Runs `resolve(path)`, unless a resolve is already in flight (a second
    /// call while `busy` is a no-op). `isCurrent` reports whether the sheet
    /// this submission started for is still the current one — false means
    /// the operator activated a different profile mid-flight, so neither
    /// `message` nor the "clear the sheet" signal applies and the completion
    /// is dropped silently (logged at debug).
    /// - Returns: whether the caller should now clear the sheet.
    @discardableResult
    public func submit(
        path: String,
        using resolve: (String) async throws -> Void,
        isCurrent: () -> Bool
    ) async -> Bool {
        guard !busy else { return false }
        busy = true
        message = nil
        defer { busy = false }
        do {
            // resolveFirstRun PUTs the root and then refreshes the store, so
            // there is nothing to reload here.
            try await resolve(path)
            return isCurrent()
        } catch {
            if isCurrent() {
                message = L.t("native_firstrun_failed", ShepherdErrorCopy.message(error))
            } else {
                Log.app.debug("dropping a stale first-run completion")
            }
            return false
        }
    }
}
