import SwiftUI

/// Panel factories for the lenses that replace the herd's live session groups.
/// Register at launch; views are built lazily in the sidebar's environment.
@MainActor
enum QueuesPanels {
    private static var registered: [HerdLens: @MainActor () -> AnyView] = [:]

    /// Idempotent per lens: the last registration wins.
    static func register(_ lens: HerdLens, panel: @escaping @MainActor () -> AnyView) {
        registered[lens] = panel
    }

    /// A missing factory leaves the sidebar's ordinary herd groups in place.
    static func panel(for lens: HerdLens) -> (@MainActor () -> AnyView)? {
        registered[lens]
    }

    /// Tests and previews only.
    static func reset() { registered.removeAll() }
}

/// S10's entry point for the integration lane's StreamRegistrations.installAll(into:).
/// AppModel owns the per-activation model; the panel registry captures no app or store.
@MainActor
enum QueuesStream {
    static func install(_ app: AppModel) {
        app.register(QueuesModel.self)
        // S7 owns HerdLens and SidebarView. After both streams merge, the integration lane
        // enables these lenses, routes panel(for:) ahead of herd groups, and tests both.
        QueuesPanels.register(.next) { AnyView(UpNextView()) }
        QueuesPanels.register(.done) { AnyView(DonePanelView()) }
        QueuesPanels.register(.owed) { AnyView(OwedPanelView()) }
    }
}
