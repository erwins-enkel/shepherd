import SwiftUI

/// Panel factories for the lenses that replace the herd's live session groups.
/// Register at launch; views are built lazily in the sidebar's environment.
@MainActor
public enum QueuesPanels {
    private static var registered: [HerdLens: @MainActor () -> AnyView] = [:]

    /// Idempotent per lens: the last registration wins.
    public static func register(_ lens: HerdLens, panel: @escaping @MainActor () -> AnyView) {
        registered[lens] = panel
    }

    /// A missing factory leaves the sidebar's ordinary herd groups in place.
    public static func panel(for lens: HerdLens) -> (@MainActor () -> AnyView)? {
        registered[lens]
    }

    /// Tests and previews only.
    static func reset() { registered.removeAll() }
}

extension CoreStreamInstallers {
    public static func installQueues(into app: AppModel) {
        StreamRegistrations.requiredHost.queuesPanels()
        app.register(QueuesModel.self)
    }
}
