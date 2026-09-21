import SwiftUI
import Testing
import ShepherdKit
@testable import ShepherdAppCore

extension CoreSeamTests {
/// State-level only: these assert what the windows will *choose*, not what
/// SwiftUI draws. Hosting a view to find that out would need a live store and a
/// window server and would prove nothing extra.
@MainActor
@Suite(.serialized)
struct SlotTests {
    init() { resetStreamSeams() }

    @Test func theSidebarFallsBackWhenUnsetAndPassesTheModelWhenSet() {
        #expect(SidebarSlot.resolution == .fallback)
        #expect(SidebarSlot.content == nil)

        var seen: ObjectIdentifier?
        SidebarSlot.content = { app in
            seen = ObjectIdentifier(app)
            return AnyView(Text(verbatim: "stream sidebar"))
        }
        #expect(SidebarSlot.resolution == .slot)

        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: CoreTestSupport.environment(defaults: defaults))
        _ = SidebarSlot.content?(app)
        #expect(seen == ObjectIdentifier(app))

        SidebarSlot.reset()
        #expect(SidebarSlot.resolution == .fallback)
    }

    @Test func theWelcomePanelAndTheActionBarFallBackUntilAStreamFillsThem() {
        #expect(WelcomeSlots.localPanelResolution == .fallback)
        #expect(ActionBarSlot.resolution == .fallback)

        WelcomeSlots.localPanel = { _ in AnyView(Text(verbatim: "local")) }
        ActionBarSlot.content = { _, _, _ in AnyView(Text(verbatim: "actions")) }
        #expect(WelcomeSlots.localPanelResolution == .slot)
        #expect(ActionBarSlot.resolution == .slot)

        WelcomeSlots.reset()
        ActionBarSlot.reset()
        #expect(WelcomeSlots.localPanel == nil)
        #expect(ActionBarSlot.content == nil)
    }
}
}
