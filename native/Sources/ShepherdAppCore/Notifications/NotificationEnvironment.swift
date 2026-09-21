import Foundation

@MainActor
public protocol NotificationFocusSource: AnyObject {
    func sample() -> Bool
    func observe(_ receive: @escaping @MainActor (Bool) -> Void)
        -> @MainActor () -> Void
}

@MainActor
public struct NotificationEnvironment {
    public let makeCenter: @MainActor () -> any NotificationCenterClient
    public let makeDefaults: @MainActor () -> UserDefaults
    public let focus: any NotificationFocusSource

    public init(
        makeCenter: @escaping @MainActor () -> any NotificationCenterClient,
        makeDefaults: @escaping @MainActor () -> UserDefaults,
        focus: any NotificationFocusSource
    ) {
        self.makeCenter = makeCenter
        self.makeDefaults = makeDefaults
        self.focus = focus
    }
}
