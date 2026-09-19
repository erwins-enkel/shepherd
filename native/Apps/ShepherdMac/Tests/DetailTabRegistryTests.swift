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
    @Test func anEmptyRegistryStillOffersTheBuiltInPromptTab() {
        DetailTabRegistry.reset()
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
}
