import SwiftUI

/// This stream's single entry point. The integration lane adds exactly one line to
/// `StreamRegistrations.installAll(into:)`:
///
///     NotificationsStream.install(app)
///
/// Idempotent: `AppModel.register` is keyed by extension type, so the launch task may run it
/// more than once.
///
/// **The settings menu item is not wired here yet.** The panel and its window controller are a
/// separate piece of work; when they land, that piece adds its own one line below — a
/// `@MainActor` entry point taking the `AppModel` and guarding its own menu item so this stays
/// safe to call twice. Nothing else in this file changes, and nothing outside
/// `Sources/Notifications/` does either.
@MainActor
enum NotificationsStream {
    static func install(_ app: AppModel) {
        app.register(NotificationsModel.self)
        // The settings panel adds exactly one line here:
        //     NotificationSettingsWindow.installMenuItem(app)
        Log.app.info("notifications stream installed")
    }
}
