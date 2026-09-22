import SwiftUI
import ShepherdAppCore

@main
struct ShepherdIOSApp: App {
    @State private var appModel: AppModel
    private let launch: IOSLaunchEnvironment

    init() {
        do {
            let launch = try IOSLaunchEnvironment(configuration: IOSLaunchEnvironment.configuration())
            self.launch = launch
            _appModel = State(initialValue: launch.makeModel())
        } catch {
            // Failing closed is essential: an isolated test must never fall back to real profiles.
            preconditionFailure("Isolated iOS storage unavailable")
        }
    }

    var body: some Scene {
        WindowGroup {
            RootView(launch: launch)
                .environment(appModel)
                .task { await launch.start(appModel) }
        }
    }
}
