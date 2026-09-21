import Testing
import ShepherdKit
@testable import ShepherdAppCore

extension CoreSeamTests {
struct CurrentSelectionTests {
@Test @MainActor
func rejectsDifferentStoreAndSelection() async throws {
    let app = CoreTestSupport.makeApp()
    defer { CoreTestSupport.cleanup(app) }
    let profile = try app.addRemoteProfile(name: "fixture", address: "https://fixture.invalid")
    await app.activate(profile)
    let first = try #require(app.store)
    let second = try SessionStore(profile: profile, credentials: InMemoryCredentialStore())
    let session = PreviewData.session()
    app.selectedSessionID = session.id
    #expect(CurrentSessionSelection.isCurrent(session: session, store: first, app: app))
    #expect(!CurrentSessionSelection.isCurrent(session: session, store: second, app: app))
    app.selectedSessionID = nil
    #expect(!CurrentSessionSelection.isCurrent(session: session, store: first, app: app))
}
}
}
