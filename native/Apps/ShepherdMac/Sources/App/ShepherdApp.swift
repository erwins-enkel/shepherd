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

/// Welcome until a profile is active; the main window after.
struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if model.store == nil {
            WelcomeView()
        } else {
            MainWindow()
        }
    }
}
