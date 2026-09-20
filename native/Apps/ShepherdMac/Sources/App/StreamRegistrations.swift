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
    /// The same two-pass lifecycle is used by the app and by probe installers in tests.
    /// The scene pass runs once; model-bound installers remain repeatable per model.
    @MainActor
    final class Installation {
        private let scene: @MainActor () -> Void
        private let model: @MainActor (AppModel) -> Void
        private var didInstallScene = false

        init(
            scene: @escaping @MainActor () -> Void,
            model: @escaping @MainActor (AppModel) -> Void
        ) {
            self.scene = scene
            self.model = model
        }

        func installScene() {
            guard !didInstallScene else { return }
            didInstallScene = true
            scene()
        }

        func reset() { didInstallScene = false }

        func installAll(into app: AppModel) {
            installScene()
            model(app)
        }
    }

    private static let installation = Installation(
        scene: {
            QueuesStream.installScene()
            MergeStream.installScene()
            Wave2Seams.installPanels()
            SettingsFeature.installScene()
        },
        model: installModels)

    /// Menu commands and settings panes, registered before any Scene exists.
    ///
    /// Called from `ShepherdApp.init()`, because `ShepherdApp.body` reads both registries while the
    /// scene is being constructed — which is BEFORE `RootView`'s `.task` runs `installAll(into:)`.
    /// Neither registry is `@Observable`. Registering commands or panes only at model time is
    /// unsupported: a dictionary write cannot invalidate a scene's earlier registry reads.
    /// Such registrations belong in the scene closure above, even when their actions need a model.
    ///
    /// Model-free on purpose: at `init()` time there is no store, no activation and no
    /// `NSApp.mainMenu`. A stream that needs the model reaches it through the `AppModel` a
    /// `MenuCommand`'s `action` is handed at invocation time. Notification models are registered
    /// in the model pass and resolved anew for each activation.
    ///
    /// Runs the scene installers exactly once per process, before any model-bound installation.
    static func installScene() {
        installation.installScene()
    }

    static func installAll(into app: AppModel) {
        installation.installAll(into: app)
    }

    /// Tests and previews reset the scene guard together with its registries.
    static func reset() { installation.reset() }

    private static func installModels(into app: AppModel) {
        TerminalInstall.install(into: app)  // S1: DetailTab "terminal" + AppExtension
        DetailFeature.install(app)          // S2: DetailTabs activity/diff/files/git + AppExtension
        SidebarInstall.run(app)             // S3: SidebarSlot + AppExtension
        ActionsStream.install(app)          // S4: ActionBarSlot.content + AppExtension
        LocalServerFeature.install(app)     // S5: WelcomeSlots.localPanel + AppExtension
        NotificationsStream.install(app)    // S6: activation-scoped notification delivery
        // Cross-stream seams, after every install: S4 reads S3's working-blocked flags and
        // S2's git snapshot through `SessionSignals` rather than reading the server again.
        SessionSignals.connect(app)
        PlanStream.install(app)             // S8: plan tab and plan signal owners
        HerdStream.install(app)             // S7: replaces the sparse S2 git seam
        QueuesStream.install(app)           // S10: scene factories already registered
        ComposeStream.install(app)          // S11: composer and session actions
        MergeStream.install(app)            // S9: composes the sidebar and complete action bar
        Wave2Seams.connect(app)
        SettingsFeature.install(app)        // S12: installed after its signal/delivery producers
        SettingsNotificationBridge.git = { $0.extension(HerdSignals.self)?.git ?? [:] }
        SettingsNotificationBridge.reviewing = { app, id in
            app.extension(HerdSignals.self)?.isReviewing(id) ?? false
        }
        SettingsNotificationBridge.sendReady = { app, session in
            guard let model = app.extension(NotificationsModel.self) else { return false }
            return await model.deliver(
                .init(kind: .ready, sessionID: session.id, subject: session.name), evaluatedReady: true)
        }
    }
}
