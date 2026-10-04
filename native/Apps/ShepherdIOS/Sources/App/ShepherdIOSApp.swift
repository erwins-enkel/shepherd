import SwiftUI
import ShepherdAppCore

@main
struct ShepherdIOSApp: App {
    @UIApplicationDelegateAdaptor(IOSAppDelegate.self) private var appDelegate
    @State private var hub: IOSServerHub
    private let launch: IOSLaunchEnvironment

    init() {
        do {
            let launch = try IOSLaunchEnvironment(configuration: IOSLaunchEnvironment.configuration())
            self.launch = launch
            _hub = State(initialValue: IOSServerHub(launch: launch))
        } catch {
            // Failing closed is essential: an isolated test must never fall back to real profiles.
            preconditionFailure("Isolated iOS storage unavailable")
        }
    }

    var body: some Scene {
        WindowGroup {
            RootView(launch: launch)
                .environment(hub)
                .environment(hub.focused)
                .background {
                    ForEach(hub.connectedIDs, id: \.self) { id in
                        if let app = hub.models[id] { IOSServerRuntimeView(app: app).environment(hub) }
                    }
                }
                .task {
                    IOSPushRegistration.shared.attach(hub, enabled: !launch.configuration.isIsolated)
                    await hub.start(launch: launch)
                }
        }
    }
}
