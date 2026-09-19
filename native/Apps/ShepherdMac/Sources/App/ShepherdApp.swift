import SwiftUI
import ShepherdKit

@main
struct ShepherdApp: App {
    @State private var model = AppModel()

    init() {
        Log.app.info("Shepherd for Mac starting")
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
        .sheet(item: $model.sheet) { sheet in
            switch sheet {
            case .login(let profile):
                LoginSheet(profile: profile) { model.sheet = nil }
            case .firstRun:
                FirstRunSheet()
            case .newSession:
                NewSessionSheet()
            }
        }
    }
}
