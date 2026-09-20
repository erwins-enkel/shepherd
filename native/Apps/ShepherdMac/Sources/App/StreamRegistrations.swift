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
    /// Menu commands and settings panes, registered before any Scene exists.
    ///
    /// Called from `ShepherdApp.init()`, because `ShepherdApp.body` reads both registries while the
    /// scene is being constructed — which is BEFORE `RootView`'s `.task` runs `installAll(into:)`.
    /// Neither registry is `@Observable`, so anything registered later simply never appears.
    ///
    /// Model-free on purpose: at `init()` time there is no store, no activation and no
    /// `NSApp.mainMenu`. A stream that needs the model reaches it through the `AppModel` a
    /// `MenuCommand`'s `action` is handed at invocation time. `NotificationsStream.install(app)`
    /// stays in `installAll(into:)` for exactly this reason — it touches `NSApp.mainMenu`, which
    /// is nil here.
    ///
    /// Idempotent by construction (both registries are keyed dictionaries), so a second call is a
    /// no-op.
    static func installScene() {
        // S12 adds `SettingsFeature.installScene()` here; S7–S11 add their command rows.
        // Empty on this branch, and that is the shipped state: `SettingsPaneRegistry.resolution`
        // is `.placeholder` and every menu is empty, which is what the tests assert.
    }

    static func installAll(into app: AppModel) {
        TerminalInstall.install(into: app)  // S1: DetailTab "terminal" + AppExtension
        DetailFeature.install(app)          // S2: DetailTabs activity/diff/files/git + AppExtension
        SidebarInstall.run(app)             // S3: SidebarSlot + AppExtension
        ActionsStream.install(app)          // S4: ActionBarSlot.content + AppExtension
        LocalServerFeature.install(app)     // S5: WelcomeSlots.localPanel + AppExtension
        NotificationsStream.install(app)    // S6: AppExtension + its own "Notifications…" menu item
        // Cross-stream seams, after every install: S4 reads S3's working-blocked flags and
        // S2's git snapshot through `SessionSignals` rather than reading the server again.
        SessionSignals.connect(app)
    }
}
