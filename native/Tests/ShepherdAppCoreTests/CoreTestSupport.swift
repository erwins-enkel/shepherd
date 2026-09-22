import Foundation
import Testing
import SwiftUI
import ShepherdKit
@testable import ShepherdAppCore

@MainActor
final class FakeFocusSource: NotificationFocusSource {
    func sample() -> Bool { false }
    func observe(_ receive: @escaping @MainActor (Bool) -> Void)
        -> @MainActor () -> Void { {} }
}

@MainActor
enum CoreTestSupport {
    private static var suites: [ObjectIdentifier: String] = [:]
    private static var configured = false
    static var promptCalls = 0

    static func configureHost() {
        guard !configured else { return }
        configured = true
        StreamRegistrations.configure(StreamHost(
            prompt: { _, _, _ in
                promptCalls += 1
                return AnyView(Text("fixture"))
            },
            queuesPanels: {}, mergeScene: {}, wave2Panels: {}, settingsScene: {},
            terminalTab: { _ in }, detailTabs: { _ in },
            sidebarSlot: { _ in }, actionBarSlot: { _ in },
            localServer: { _ in }, planTab: { _ in },
            compose: { _ in }, mergePresentation: { _ in }))
    }

    static func makeApp() -> AppModel {
        let name = "run.shepherd.core.tests." + UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(),
            notifications: NotificationEnvironment(
                makeCenter: { FakeNotificationCenter() },
                makeDefaults: { defaults }, focus: FakeFocusSource()))
        suites[ObjectIdentifier(app)] = name
        return app
    }

    static func cleanup(_ app: AppModel) {
        app.teardown()
        if let name = suites.removeValue(forKey: ObjectIdentifier(app)) {
            UserDefaults(suiteName: name)?.removePersistentDomain(forName: name)
        }
    }
}

@MainActor
extension CoreTestSupport {
    static func environment(defaults: UserDefaults) -> NotificationEnvironment {
        NotificationEnvironment(makeCenter: { FakeNotificationCenter() }, makeDefaults: { defaults }, focus: FakeFocusSource())
    }
}

@MainActor
func resetStreamSeams() {
    CoreTestSupport.configureHost()
    ShepherdAppCore.resetStreamSeams()
}
