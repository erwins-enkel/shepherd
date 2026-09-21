import Foundation
import Observation
import ShepherdKit
import ShepherdAppCore

@MainActor
private final class MacTestFocus: NotificationFocusSource {
    func sample() -> Bool { false }
    func observe(_ receive: @escaping @MainActor (Bool) -> Void) -> @MainActor () -> Void { {} }
}
@MainActor
enum MacTestSupport {
    static func environment(defaults: UserDefaults) -> NotificationEnvironment {
        NotificationEnvironment(makeCenter: { FakeNotificationCenter() }, makeDefaults: { defaults }, focus: MacTestFocus())
    }
}

// Small hand-driven connection fixture shared by the retained render scenarios.
@Observable
@MainActor
final class ConnectionBox {
    var state: ConnectionState = .idle
}
