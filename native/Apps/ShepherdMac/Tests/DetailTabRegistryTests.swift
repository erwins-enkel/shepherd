import SwiftUI
import Testing
import ShepherdKit
@testable import Shepherd

/// A stand-in stream tab. Stateless, so `Sendable` costs nothing.
private struct StubTab: DetailTab {
    let id: String
    let order: Int
    var title: String { id }
    let systemImage = "circle"

    @MainActor
    func makeView(session: Session, store: SessionStore, app: AppModel) -> AnyView {
        AnyView(Text(verbatim: id))
    }
}

/// `.serialized`: the registry is per-process state, so these may not interleave.
@MainActor
@Suite(.serialized)
struct DetailTabRegistryTests {
    init() { resetStreamSeams() }

    @Test func anEmptyRegistryStillOffersTheBuiltInPromptTab() {
        #expect(DetailTabRegistry.tabs.map(\.id) == ["prompt"])
    }

    @Test func tabsAreOrderedByOrderThenID() {
        DetailTabRegistry.reset()
        DetailTabRegistry.register(StubTab(id: "diff", order: 5))
        DetailTabRegistry.register(StubTab(id: "terminal", order: 0))
        DetailTabRegistry.register(StubTab(id: "activity", order: 5))
        #expect(DetailTabRegistry.tabs.map(\.id) == ["terminal", "activity", "diff", "prompt"])
    }

    @Test func anIDIsRegisteredOnce_andThePromptTabCanBeReplacedAndRestored() {
        DetailTabRegistry.reset()
        DetailTabRegistry.register(StubTab(id: "diff", order: 9))
        DetailTabRegistry.register(StubTab(id: "diff", order: 1))
        #expect(DetailTabRegistry.tabs.map(\.id) == ["diff", "prompt"])
        #expect(DetailTabRegistry.tabs.first?.order == 1)

        DetailTabRegistry.reset()
        DetailTabRegistry.register(StubTab(id: DetailTabRegistry.promptTabID, order: 3))
        #expect(DetailTabRegistry.tabs.count == 1)
        #expect(DetailTabRegistry.tabs.first?.order == 3)

        DetailTabRegistry.reset()
        #expect(DetailTabRegistry.tabs.map(\.id) == ["prompt"])
    }

    @Test func theLonePromptTabRendersWithoutTabChrome() {
        // The shipped state: one tab, so `SessionDetailView` draws its content
        // directly. A `TabView` here would add a tab bar with nothing to switch
        // to, which reads as a bug rather than as a pane waiting for streams.
        #expect(DetailTabRegistry.tabs.count == 1)
        #expect(DetailTabRegistry.layout == .single)

        // A stream registering its first tab is what brings the bar back.
        DetailTabRegistry.register(StubTab(id: "terminal", order: 0))
        #expect(DetailTabRegistry.layout == .tabbed)

        // Replacing the prompt tab rather than adding to it stays single.
        DetailTabRegistry.reset()
        DetailTabRegistry.register(StubTab(id: DetailTabRegistry.promptTabID, order: 3))
        #expect(DetailTabRegistry.layout == .single)
    }

    @Test func theLayoutRuleIsAboutTheCountAlone() {
        #expect(DetailTabRegistry.layout(forTabCount: 1) == .single)
        #expect(DetailTabRegistry.layout(forTabCount: 2) == .tabbed)
        #expect(DetailTabRegistry.layout(forTabCount: 5) == .tabbed)
        // Never reached — `tabs` always carries the built-in prompt tab — but it
        // must not be the single-tab branch, which would draw a missing tab.
        #expect(DetailTabRegistry.layout(forTabCount: 0) == .tabbed)
    }
}
