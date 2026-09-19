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
        Log.app.info("Shepherd for Mac starting — \(launch.logDescription, privacy: .public)")
    }

    var body: some Scene {
        WindowGroup("Shepherd") {
            RootView()
                .environment(model)
                .frame(minWidth: 900, minHeight: 600)
        }
        .defaultSize(width: 1100, height: 720)
        .windowResizability(.contentMinSize)
    }
}

/// Welcome until a profile is active; the main window after. Owns the three
/// app-level sheets so login and first run can appear over either surface, and
/// the sign-out notice, which has to outlive the window it was triggered from.
struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model

        return VStack(spacing: 0) {
            if let warning = model.signOutWarning {
                NoticeBar(message: warning) { model.signOutWarning = nil }
            }
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
        // after the restored activation would miss it.
        .task {
            StreamRegistrations.installAll(into: model)
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
