import Foundation
import ShepherdAppCore
import ShepherdKit

@MainActor
final class IOSLaunchEnvironment {
    struct Configuration: Equatable {
        var isIsolated = false
        var baseURL: String?
        var password: String?
        var runID: String?
        var statusPath: String?
        var handoffPath: String?
    }
    enum LaunchError: Error { case privateStorageUnavailable, incompleteLiveConfiguration }
    let configuration: Configuration
    let defaults: UserDefaults
    let credentials: any CredentialStore
    private(set) var cleanup: IOSLiveCleanup?
    private var started = false

    static func configuration(arguments: [String] = ProcessInfo.processInfo.arguments,
                              environment: [String: String] = ProcessInfo.processInfo.environment) -> Configuration {
        func value(_ key: String) -> String? { environment[key] ?? environment["TEST_RUNNER_" + key] }
        func on(_ value: String?) -> Bool { ["1", "true", "yes", "on"].contains(value?.lowercased() ?? "") }
        var isolated = on(value("SHEPHERD_ISOLATED"))
        for (index, argument) in arguments.enumerated() {
            if argument == "-ShepherdIsolated" {
                isolated = index + 1 == arguments.count || arguments[index + 1].hasPrefix("-") || on(arguments[index + 1])
            } else if argument.hasPrefix("-ShepherdIsolated=") {
                isolated = on(String(argument.dropFirst("-ShepherdIsolated=".count)))
            }
        }
        guard isolated else { return .init() }
        return .init(isIsolated: true, baseURL: value("SHEPHERD_LIVE_BASE_URL"),
            password: value("SHEPHERD_LIVE_PASSWORD"), runID: value("SHEPHERD_IOS_RUN_ID"),
            statusPath: value("SHEPHERD_IOS_CLEANUP_STATUS_PATH"), handoffPath: value("SHEPHERD_IOS_TOKEN_HANDOFF_PATH"))
    }

    init(configuration: Configuration, makeDefaults: (String) -> UserDefaults? = { UserDefaults(suiteName: $0) }) throws {
        self.configuration = configuration
        if configuration.isIsolated {
            guard let defaults = makeDefaults("run.shepherd.ios.isolated.\(UUID().uuidString)") else {
                throw LaunchError.privateStorageUnavailable
            }
            self.defaults = defaults
            credentials = InMemoryCredentialStore()
        } else {
            defaults = .standard
            credentials = KeychainCredentialStore()
        }
    }

    func makeModel() -> AppModel {
        let app = AppModel(defaults: defaults, credentials: credentials,
            notifications: IOSNotificationEnvironment.make(defaults: defaults))
        app.register(SidebarModel.self)
        app.register(DetailModel.self)
        app.allowsQueueRecomputation = false
        app.allowsTerminalInput = false
        app.liveRequestAudit = ReadOnlyRequestAudit()
        app.login = { profile, password, credentials in
            try await ProfileSetup.login(profile: profile, password: password, credentials: credentials,
                tokenName: ProfileSetup.tokenName(prefix: "Shepherd for iOS ("))
        }
        return app
    }

    func start(_ app: AppModel) async {
        guard !started else { return }
        started = true
        guard configuration.isIsolated, let baseURL = configuration.baseURL else {
            await app.restoreActiveProfile()
            return
        }
        do {
            guard let password = configuration.password, let runID = configuration.runID,
                  let statusPath = configuration.statusPath, let handoffPath = configuration.handoffPath else {
                throw LaunchError.incompleteLiveConfiguration
            }
            let profile = try app.addRemoteProfile(name: "Live", address: baseURL)
            let cleanup = IOSLiveCleanup(runID: runID, statusPath: statusPath, handoffPath: handoffPath)
            self.cleanup = cleanup
            let recorder = IOSOwnedCredentialStore(destination: credentials, cleanup: cleanup, profile: profile)
            try await ProfileSetup.login(profile: profile, password: password, credentials: recorder,
                tokenName: ProfileSetup.tokenName(prefix: "Shepherd UI test (", hostName: runID))
            await app.activate(profile)
        } catch {
            app.isolatedLaunchError = L.t("native_error_offline")
        }
    }
}
