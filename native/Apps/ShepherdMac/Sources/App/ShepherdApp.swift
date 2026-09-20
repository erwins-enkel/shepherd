import SwiftUI
import ShepherdKit

@main
struct ShepherdApp: App {
    @State private var model: AppModel
    /// Non-nil only for an isolated launch — `-ShepherdIsolated 1` or
    /// `SHEPHERD_ISOLATED=1`. See `LaunchEnvironment`: it is what keeps an
    /// automated launch off the login Keychain and out of the operator's saved
    /// profiles. A normal launch builds the model exactly as before.
    private let isolation: IsolatedLaunch?

    init() {
        // Everything the isolated launch needs — the throwaway stores, the
        // quit-time cleanup and the optional live sign-in — is wired up by
        // `IsolatedLaunch` itself rather than by a modifier on the scene below.
        // That is not tidiness: an `.onReceive` of `NSApplication`'s terminate
        // notification here left the app with no window at all under XCUITest.
        let launch = LaunchEnvironment.configuration()
        let isolation = launch.isIsolated ? IsolatedLaunch(configuration: launch) : nil
        self.isolation = isolation
        _model = State(initialValue: isolation?.makeModel() ?? AppModel())
        // Before `body` is first evaluated — see StreamRegistrations.installScene().
        StreamRegistrations.installScene()
        Log.app.info("Shepherd for Mac starting — \(launch.logDescription, privacy: .public)")
    }

    var body: some Scene {
        WindowGroup("Shepherd") {
            RootView(startIsolatedSeed: isolation?.startLiveSeedIfNeeded)
                .environment(model)
                .frame(minWidth: 900, minHeight: 600)
        }
        .defaultSize(width: 1100, height: 720)
        .windowResizability(.contentMinSize)
        .commands {
            CommandGroup(after: .newItem) { MenuCommandItems(menu: .file, app: model) }
            CommandGroup(after: .toolbar) { MenuCommandItems(menu: .view, app: model) }
            // CommandsBuilder supports this scene-time condition. With no registered commands,
            // omit the top-level menu entirely; model-time registration is unsupported.
            if !CommandRegistry.commands(in: .session).isEmpty {
                CommandMenu(L.t("native_menu_session")) { MenuCommandItems(menu: .session, app: model) }
            }
            CommandGroup(after: .windowArrangement) { MenuCommandItems(menu: .window, app: model) }
            CommandGroup(replacing: .help) { MenuCommandItems(menu: .help, app: model) }
        }

        Settings {
            SettingsSceneView()
                .environment(model)
        }
    }
}

/// Welcome until a profile is active; the main window after. Owns the three
/// app-level sheets so login and first run can appear over either surface, and
/// the sign-out notice, which has to outlive the window it was triggered from.
struct RootView: View {
    @Environment(AppModel.self) private var model
    /// `IsolatedLaunch.startLiveSeedIfNeeded`, for an isolated launch with a
    /// live seed configured — `nil` for every other launch. Passed in rather
    /// than reached for through `ShepherdApp` directly: `IsolatedLaunch` is
    /// owned by the app, not the environment, and this is the one call this
    /// view needs from it.
    var startIsolatedSeed: (() -> Void)? = nil

    var body: some View {
        @Bindable var model = model

        return VStack(spacing: 0) {
            if let warning = model.signOutWarning {
                NoticeBar(message: warning) { model.signOutWarning = nil }
            }
            if let isolatedLaunchError = model.isolatedLaunchError {
                NoticeBar(message: isolatedLaunchError) { model.isolatedLaunchError = nil }
            }
            if let audit = model.liveRequestAudit { LiveRequestAuditView(audit: audit) }
            Group {
                if model.store == nil {
                    WelcomeView()
                } else {
                    MainWindow()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        // The profile restored from UserDefaults is only a *name* until
        // something starts a store for it; without this the app came back from
        // a relaunch with an active profile and nothing behind it. Idempotent,
        // so a second appearance keeps the store already running.
        // Registration runs first and synchronously: an extension registered
        // after the restored activation would miss it. The isolated launch's
        // live seed starts right after, for the same reason — its `signIn`
        // ends in `activate(_:)`, and a stream extension registered after that
        // call would have missed the activation's first frame. See
        // `IsolatedLaunch.startLiveSeedIfNeeded()`.
        .task {
            StreamRegistrations.installAll(into: model)
            startIsolatedSeed?()
            await model.restoreActiveProfile()
        }
        .sheet(item: $model.sheet) { sheet in
            switch sheet {
            case .login(let profile):
                // Narrow, not `model.sheet = nil`: this closure also runs after
                // a *successful* sign-in, and by then `activate(_:)` has already
                // cleared this sheet and the new activation's watcher may have
                // routed the next one. Clearing unconditionally would take that
                // one down with it — a `.firstRun` nobody would ever see again.
                LoginSheet(profile: profile) {
                    if case .login = model.sheet { model.sheet = nil }
                }
            case .firstRun:
                FirstRunSheet()
            case .newSession:
                NewSessionSheet()
            }
        }
    }
}

/// Isolated-test diagnostics contain counts only and are absent from normal launches.
struct LiveRequestAuditView: View {
    let audit: ReadOnlyRequestAudit
    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.5)) { _ in
            let counts = audit.counts
            let summary = "Live audit: \(counts.reads) reads; \(counts.rejected) rejected"
            Text(verbatim: summary)
                .font(.caption2)
                .accessibilityLabel(Text(verbatim: summary))
                .accessibilityIdentifier("live-request-audit")
        }
    }
}
