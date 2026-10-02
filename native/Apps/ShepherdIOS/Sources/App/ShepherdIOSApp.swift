import SwiftUI
import ShepherdAppCore

@main
struct ShepherdIOSApp: App {
    @UIApplicationDelegateAdaptor(IOSAppDelegate.self) private var appDelegate
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
                .task {
                    IOSPushRegistration.shared.attach(appModel, enabled: !launch.configuration.isIsolated)
                    await launch.start(appModel)
                }
                .onChange(of: appModel.store.map(ObjectIdentifier.init), initial: true) { _, _ in
                    IOSPushRegistration.shared.storeChanged()
                }
        }
    }
}
