import SwiftUI

/// The single place a merged stream is wired into the app.
///
/// Owned by the integration lane (S0-int): each stream merge adds exactly one
/// line here and nothing else in `Sources/App/` changes. That is what keeps
/// `ShepherdApp.swift`, `MainWindow.swift` and `AppModel.swift` out of every
/// stream's diff.
///
/// Idempotent by construction — `DetailTabRegistry.register` is keyed by tab id,
/// `AppModel.register` by extension type, a slot assignment is a plain overwrite
/// — so the launch task may run it more than once.
@MainActor
enum StreamRegistrations {
    static func installAll(into app: AppModel) {
        // Streams add one line each, e.g.
        //   TerminalStream.install(app)   // S1: DetailTab + AppExtension
        //   SidebarStream.install(app)    // S3: SidebarSlot
        _ = app
    }
}
