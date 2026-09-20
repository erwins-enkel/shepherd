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

/// Integration lane: call installScene() from StreamRegistrations.installScene(), before
/// any view reads the non-observable panel registry. Call install(_:) from installAll(into:),
/// before activation/live seeding; late registration also reconciles an already-live store.
/// After S7/S10 merge, enable the three lenses and route SidebarView through panel(for:).
/// Mount HeldQueueView and QueueActionsView with the active QueuesModel in the header.
/// AppModel owns the per-activation model; scene factories capture no app or store.
@MainActor
enum QueuesStream {
    static func installScene() {
        // S7 owns HerdLens and SidebarView. After both streams merge, the integration lane
        // enables these lenses, routes panel(for:) ahead of herd groups, and tests both.
        QueuesPanels.register(.next) { AnyView(UpNextView()) }
        QueuesPanels.register(.done) { AnyView(DonePanelView()) }
        QueuesPanels.register(.owed) { AnyView(OwedPanelView()) }
    }

    static func install(_ app: AppModel) {
        // Keep direct installers/previews safe; production registers before scene construction.
        installScene()
        app.register(QueuesModel.self)
    }
}
