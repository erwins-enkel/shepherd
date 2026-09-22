import SwiftUI

/// Where S3 replaces the flat session list. `MainWindow` renders
/// `SidebarSlot.content(model)` when set and its own list otherwise.
///
/// The closure type carries `@MainActor` (Swift 6): a stream's sidebar reads
/// `AppModel` and its store, both main-actor-isolated.
@MainActor
public enum SidebarSlot {
    /// What a window will render. Named rather than inferred at the call site, so
    /// the choice is assertable without hosting a view.
    enum Resolution: Equatable {
        /// The built-in content ships.
        case fallback
        /// A stream has taken the slot.
        case slot
    }

    public static var content: (@MainActor (AppModel) -> AnyView)?
    static var resolution: Resolution { content == nil ? .fallback : .slot }
    /// Tests and previews only.
    static func reset() { content = nil }
}
