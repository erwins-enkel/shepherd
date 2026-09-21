import SwiftUI
import ShepherdKit
import ShepherdAppCore

@MainActor
enum MacStreamHost {
    private static var configured = false
    static func configure() {
        guard !configured else { return }
        configured = true
        StreamRegistrations.configure(StreamHost(
            prompt: { session, _, _ in AnyView(PromptTabView(session: session)) },
            queuesPanels: QueuesStream.installScene,
            mergeScene: MergeStream.installScene,
            wave2Panels: Wave2Seams.installPanels,
            settingsScene: SettingsFeature.installScene,
            terminalTab: TerminalInstall.installTab,
            detailTabs: DetailFeature.installTabs,
            sidebarSlot: SidebarInstall.installSlot,
            actionBarSlot: ActionsStream.installSlot,
            localServer: LocalServerFeature.install,
            planTab: { _ in DetailTabRegistry.register(PlanDetailTab()) },
            compose: ComposeStream.install,
            mergePresentation: MergeStream.installPresentation))
    }
}

#if DEBUG
extension MacStreamHost {
    static func makePreview() -> AppModel {
        configure()
        let defaults = UserDefaults(suiteName: "preview-" + UUID().uuidString)!
        return AppModel(defaults: defaults, credentials: InMemoryCredentialStore(),
            notifications: NotificationEnvironment(makeCenter: { FakeNotificationCenter() },
                makeDefaults: { defaults }, focus: PreviewFocus()))
    }
    private final class PreviewFocus: NotificationFocusSource {
        func sample() -> Bool { false }
        func observe(_ receive: @escaping @MainActor (Bool) -> Void) -> @MainActor () -> Void { {} }
    }
}
#endif
