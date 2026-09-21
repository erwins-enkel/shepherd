import SwiftUI

/// Where S5 fills the "Run on this Mac" card body — status, install and start
/// controls — without editing `WelcomeView`. The card chrome (title, blurb,
/// divider) stays with the welcome screen; only the body below it is the slot.
@MainActor
public enum WelcomeSlots {
    public static var localPanel: (@MainActor (AppModel) -> AnyView)?
    static var localPanelResolution: SidebarSlot.Resolution {
        localPanel == nil ? .fallback : .slot
    }
    /// Tests and previews only.
    static func reset() { localPanel = nil }
}
