import SwiftUI
import ShepherdKit

/// The sheet's busy/dismiss gate, pulled out of the view so it is unit-testable
/// without hosting SwiftUI (see LoginSheetStateTests).
public struct LoginSheetState: Equatable {
    public init() {}

    public var busy = false
    public var error: String?
    /// While a sign-in request is in flight, Cancel and the sheet's own
    /// interactive dismissal must both be blocked: dismissing does not cancel
    /// the untracked `Task` in `submit()`, so a stale success would later
    /// activate the wrong profile and fire a dismissal closure that now
    /// belongs to a different sheet.
    public var canDismiss: Bool { !busy }
}
