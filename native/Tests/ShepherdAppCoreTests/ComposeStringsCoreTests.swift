import Foundation
import ShepherdKit
import Testing
@testable import ShepherdAppCore

@MainActor @Suite struct ComposeStringsTests {

}

extension CoreSeamTests {
@MainActor @Suite struct ComposeCapacityStringsTests {
    @Test func capacityCopyUsesExistingKeysAndShowsOnlyFutureResets() {
        let now = Date(timeIntervalSince1970: 1000)
        let future = ComposeCapacity.Window(key: "WK", pct: 7, resetAt: 2_000_000)
        #expect(future.copy(now: now) == L.t("newtask_provider_capacity_free_until",
            93.formatted(), Date(timeIntervalSince1970: 2000).formatted(date: .abbreviated, time: .shortened)))
        let past = ComposeCapacity.Window(key: "5H", pct: 7, resetAt: 1_000_000)
        #expect(past.copy(now: now) == L.t("newtask_provider_capacity_free", 93.formatted()))
        #expect(L.t("newtask_agent_provider_codex_alpha_badge") == "Alpha MVP")
        #expect(!future.copy(now: now).contains("{pct}"))
    }
}
}
