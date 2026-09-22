import ShepherdAppCore
import SwiftUI

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
        MacStreamHost.configure()
        CoreStreamInstallers.installQueues(into: app)
    }
}
