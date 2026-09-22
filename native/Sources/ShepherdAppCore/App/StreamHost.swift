import SwiftUI
import ShepherdKit

@MainActor
public struct StreamHost {
    public typealias SceneHook = @MainActor () -> Void
    public typealias ModelHook = @MainActor (AppModel) -> Void
    public typealias PromptRenderer =
        @MainActor (Session, SessionStore, AppModel) -> AnyView

    public let prompt: PromptRenderer
    public let queuesPanels: SceneHook
    public let mergeScene: SceneHook
    public let wave2Panels: SceneHook
    public let settingsScene: SceneHook
    public let terminalTab: ModelHook
    public let detailTabs: ModelHook
    public let sidebarSlot: ModelHook
    public let actionBarSlot: ModelHook
    public let localServer: ModelHook
    public let planTab: ModelHook
    public let compose: ModelHook
    public let mergePresentation: ModelHook

    public init(
        prompt: @escaping PromptRenderer,
        queuesPanels: @escaping SceneHook,
        mergeScene: @escaping SceneHook,
        wave2Panels: @escaping SceneHook,
        settingsScene: @escaping SceneHook,
        terminalTab: @escaping ModelHook,
        detailTabs: @escaping ModelHook,
        sidebarSlot: @escaping ModelHook,
        actionBarSlot: @escaping ModelHook,
        localServer: @escaping ModelHook,
        planTab: @escaping ModelHook,
        compose: @escaping ModelHook,
        mergePresentation: @escaping ModelHook
    ) {
        self.prompt = prompt
        self.queuesPanels = queuesPanels
        self.mergeScene = mergeScene
        self.wave2Panels = wave2Panels
        self.settingsScene = settingsScene
        self.terminalTab = terminalTab
        self.detailTabs = detailTabs
        self.sidebarSlot = sidebarSlot
        self.actionBarSlot = actionBarSlot
        self.localServer = localServer
        self.planTab = planTab
        self.compose = compose
        self.mergePresentation = mergePresentation
    }
}
