import SwiftUI

/// A pane in the app's `Settings` scene. Streams register one each instead of editing
/// `ShepherdApp`, which is how S6's notification prefs and S12's five panes coexist without either
/// touching the other's file.
///
/// Mirrors `DetailTab` deliberately, down to `order` and the `makeView` signature: two registries
/// with different shapes would be two things to learn for no gain.
public protocol SettingsPane: Identifiable, Sendable where ID == String {
    /// Registry key: "general", "notifications", "workspace", "clis", "access", "diagnose".
    var id: String { get }
    /// Read through `L.t(...)` at render time, never stored.
    var title: String { get }
    var systemImage: String { get }
    /// Ascending sort key; ties break on `id`.
    var order: Int { get }

    @MainActor func makeView(app: AppModel) -> AnyView
}

/// Where streams hang their settings panes. Same contract as `CommandRegistry`: registered from
/// `StreamRegistrations.installScene()` before any Scene exists, read during body evaluation.
@MainActor
public enum SettingsPaneRegistry {
    /// What the Settings scene will draw. Named rather than decided inline, for the same reason
    /// `SidebarSlot.Resolution` is: the choice is assertable without hosting a view.
    public enum Resolution: Equatable {
        /// Nothing registered — the scene shows the "no settings yet" placeholder. This is what
        /// ships until S6 moves its panel over and S12 lands the rest.
        case placeholder
        /// One or more panes.
        case panes
    }

    private static var registered: [String: any SettingsPane] = [:]

    /// Idempotent per id — the last registration wins.
    public static func register(_ pane: any SettingsPane) { registered[pane.id] = pane }

    public static var panes: [any SettingsPane] {
        registered.values.sorted { ($0.order, $0.id) < ($1.order, $1.id) }
    }

    public static var resolution: Resolution { registered.isEmpty ? .placeholder : .panes }

    /// Tests and previews only.
    static func reset() { registered.removeAll() }
}
