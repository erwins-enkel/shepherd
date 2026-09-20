import SwiftUI

/// This stream's single entry point. The integration lane adds exactly one line to
/// `StreamRegistrations.installAll(into:)`:
///
///     NotificationsStream.install(app)
///
/// Idempotent: `AppModel.register` is keyed by extension type, so the launch task may run it
/// more than once.
///
/// That one line is the whole of the integration lane's debt. The settings menu item is **not**
/// something S0-int has to wire: `install` adds it here, through
/// `NotificationSettingsWindow.installMenuItem(app)`, which guards itself and is safe to call
/// twice. Nothing outside `Sources/Notifications/` is touched by this stream.
@MainActor
enum NotificationsStream {
    static func install(_ app: AppModel) {
        app.register(NotificationsModel.self)
        NotificationSettingsWindow.installMenuItem(app)
        Log.app.info("notifications stream installed")
    }
}
