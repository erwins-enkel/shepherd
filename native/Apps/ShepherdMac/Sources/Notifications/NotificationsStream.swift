import SwiftUI

/// Registers the activation-scoped notification model; S12 owns its Settings scene pane.
@MainActor
enum NotificationsStream {
    static func install(_ app: AppModel) {
        app.register(NotificationsModel.self)
        Log.app.info("notifications stream installed")
    }
}
