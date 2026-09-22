import Foundation
import ShepherdKit
import Testing
@testable import ShepherdAppCore

@Suite(.serialized)
@MainActor
struct AppModelEventCompositionTests {
    @Test func activationReceivesEventsAndProfileSwitchStopsOldSocket() async throws {
        let first = try AppModelEventFixture()
        let second = try AppModelEventFixture()
        defer { first.stop(); second.stop() }
        let suite = "run.shepherd.tests.events." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let credentials = InMemoryCredentialStore()
        let app = AppModel(defaults: defaults, credentials: credentials,
            notifications: CoreTestSupport.environment(defaults: defaults))
        defer { app.teardown() }
        app.register(SidebarModel.self)
        let audit = ReadOnlyRequestAudit()
        app.liveRequestAudit = audit
        let profile = try app.addRemoteProfile(name: "First", address: first.url.absoluteString)
        let replacement = try app.addRemoteProfile(name: "Second", address: second.url.absoluteString)
        try credentials.save(StoredCredential(token: "fixture-only-token", tokenId: "fixture"), for: profile.credentialKey)
        try credentials.save(StoredCredential(token: "fixture-only-token", tokenId: "fixture"), for: replacement.credentialKey)
        await app.activate(profile)
        #expect(await eventually { app.store?.connection == .live })
        try #require(await eventually { first.connectionCount == 1 })
        let sidebar = try #require(app.extension(SidebarModel.self))
        let session = Session(id: "event-session", desig: "TEST-1", name: "Event session", prompt: "fixture", repoPath: "/repos/demo", baseBranch: "main", worktreePath: "/repos/demo-test", isolated: false, herdrSession: "fixture", herdrAgentId: "fixture", claudeSessionId: "fixture", readyToMerge: false, autopilotPaused: false, autopilotComplete: false, auto: false, status: SessionStatus(known: .running), lastState: Components.Schemas.HerdrState(known: .working), createdAt: 1, updatedAt: 1, manualSteps: [])
        let payload = String(decoding: try JSONEncoder().encode(session), as: UTF8.self)
        first.send("{\"event\":\"session:new\",\"data\":\(payload)}")
        #expect(await eventually { sidebar.sessions.contains { $0.id == session.id } })
        let store = try #require(app.store)
        await store.setActive(true)
        #expect(await eventually { first.receivedTexts.contains { $0.contains("presence") && $0.contains("true") } })
        #expect(audit.counts.reads >= 3)
        #expect(audit.counts.rejected == 0)
        await app.activate(replacement)
        #expect(await eventually { second.connectionCount == 1 && first.closeCount > 0 })
        let oldCount = first.receivedTexts.count
        await store.setActive(true)
        await app.store?.setActive(true)
        #expect(await eventually { second.receivedTexts.contains { $0.contains("true") } })
        #expect(first.receivedTexts.count == oldCount)
        #expect(first.connectionCount == 1)
        #expect(app.extension(SidebarModel.self) !== sidebar)
    }

    private func eventually(_ condition: () -> Bool) async -> Bool {
        for _ in 0..<250 {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(20))
        }
        return condition()
    }
}
