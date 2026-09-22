import Foundation
import SwiftUI
import Testing
import ShepherdKit
@testable import ShepherdAppCore

extension CoreSeamTests {
@MainActor
@Suite(.serialized)
struct CoreInstallationTests {
    @Test func resetKeepsPromptHost() throws {
        CoreTestSupport.configureHost()
        resetStreamSeams()
        defer { resetStreamSeams() }
        let app = CoreTestSupport.makeApp()
        defer { CoreTestSupport.cleanup(app) }
        let profile = ServerProfile(name: "fixture", baseURL: URL(string: "https://fixture.invalid")!, mode: .remote)
        let store = try SessionStore(profile: profile, credentials: InMemoryCredentialStore())
        let session = PreviewData.session()
        let before = CoreTestSupport.promptCalls
        _ = PromptDetailTab().makeView(session: session, store: store, app: app)
        DetailTabRegistry.register(OverridePrompt())
        resetStreamSeams()
        #expect(DetailTabRegistry.tabs.map(\.id) == ["prompt"])
        _ = try #require(DetailTabRegistry.tabs.first).makeView(session: session, store: store, app: app)
        #expect(CoreTestSupport.promptCalls == before + 2)
    }
}
}
private struct OverridePrompt: DetailTab {
    let id = "prompt"
    let title = "override"
    let systemImage = "star"
    let order = 0
    @MainActor func makeView(session: Session, store: SessionStore, app: AppModel) -> AnyView { AnyView(Text("override")) }
}
