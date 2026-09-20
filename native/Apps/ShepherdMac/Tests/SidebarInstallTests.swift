import SwiftUI
import Testing
import ShepherdKit

@testable import Shepherd

/// `SidebarInstall.run(_:)` is the stream's one call site into `StreamRegistrations`, and the
/// launch task that calls it may run more than once (see `StreamRegistrations`'s own doc comment).
/// These assert that running it twice leaves the app exactly where running it once would.
@MainActor
@Suite(.serialized)
struct SidebarInstallTests {
    init() { resetStreamSeams() }

    private func app() -> AppModel {
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
    }

    @Test func runFillsTheSlotAndRegistersTheModelExactlyOnce() {
        let model = app()
        #expect(SidebarSlot.resolution == .fallback)

        SidebarInstall.run(model)

        #expect(SidebarSlot.resolution == .slot)
        let sidebarKey = ObjectIdentifier(SidebarModel.self)
        #expect(model.extensionFactories.filter { $0.key == sidebarKey }.count == 1)
    }

    @Test func runTwiceStaysIdempotent() {
        let model = app()

        SidebarInstall.run(model)
        SidebarInstall.run(model)

        let sidebarKey = ObjectIdentifier(SidebarModel.self)
        #expect(model.extensionFactories.filter { $0.key == sidebarKey }.count == 1)
        #expect(SidebarSlot.resolution == .slot)
    }

    /// Without a live `SessionStore` there is no live `SidebarModel` for the slot to hand back, so
    /// the installed closure degrades to an empty view rather than crashing.
    @Test func theSlotClosureIsEmptyWithNoLiveStore() {
        let model = app()
        SidebarInstall.run(model)

        #expect(model.extension(SidebarModel.self) == nil)
        _ = SidebarSlot.content?(model)
    }
}
