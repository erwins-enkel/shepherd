import SwiftUI
import ShepherdKit

/// Where S4 fills the quick-action bar under the detail pane. Unlike the other
/// two slots there is no built-in content: unset means no bar, which is what
/// Gate 2 shipped.
@MainActor
enum ActionBarSlot {
    static var content: (@MainActor (Session, SessionStore, AppModel) -> AnyView)?
    static var resolution: SidebarSlot.Resolution { content == nil ? .fallback : .slot }
    /// Tests and previews only.
    static func reset() { content = nil }
}
