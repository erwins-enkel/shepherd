import Foundation
import ShepherdKit
import Testing
@testable import ShepherdAppCore

extension CoreSeamTests {
@MainActor
@Suite(.serialized)
struct RemoteSessionParityTests {
    private func eventually(_ test: () -> Bool) async -> Bool {
        for _ in 0..<500 {
            if test() { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return test()
    }

    @Test func ownerSnapshotsSurviveLocalRefreshReceiveEventsAndClearOnRemoval() async throws {
        let server = SettingsFakeServer()
        let suite = "RemoteParity.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(),
            notifications: CoreTestSupport.environment(defaults: defaults))
        let profile = ServerProfile(name: "Mo", baseURL: server.baseURL, mode: .local, credentialKey: "k")
        let client = try ShepherdClient(profile: profile, credentials: InMemoryCredentialStore(), urlSession: server.urlSession())
        let store = SessionStore(client: client, events: nil)
        var session = PreviewData.session(id: "remote")
        session.host = .init(instanceId: "mac", name: "MacBook", platform: .init(known: .macos))
        session.connection = .init(state: .init(known: .connected), since: 1)
        store.acceptSession(PreviewData.session(id: "local")); store.acceptSession(session)
        let recap = Recap(sessionId: "remote", state: .init(known: .ready), headline: "Owner recap",
            body: "body", openItems: [], updatedAt: 1)
        let gate = PlanGate(sessionId: "remote", planHash: "hash", decision: .init(known: .approved),
            summary: "Owner plan", body: "", findings: [], round: 1, cap: 3, approved: true, plan: "# Plan", updatedAt: 1)
        let bodies: [String: Data] = [
            "/api/recaps": try JSONEncoder().encode(["remote": recap]),
            "/api/plan-gates": try JSONEncoder().encode(["remote": gate]),
            "/api/plan-gates/inflight": Data("[]".utf8),
            "/api/queues": Data(#"{"remote":{"sessionId":"remote","steps":[],"approved":true}}"#.utf8),
        ]
        for (path, body) in bodies {
            server.on("GET", path) { request in
                #expect(request.query == "host=mac")
                return SettingsFakeResponse(body: body)
            }
        }
        let actions = ActionsModel(store: store, app: app)
        actions.reads = .init(recaps: { [:] })
        let plan = PlanModel(store: store, app: app)
        plan.reads = .init(gates: { [:] }, inflight: { [] })
        let merge = MergeModel(store: store, app: app)
        let sessions = try JSONEncoder().encode(store.visibleSessions)
        server.stub("GET", "/api/sessions", status: 200, json: sessions)
        server.stub("GET", "/api/settings", status: 200, json: try JSONEncoder().encode(ShepherdKit.Settings(repoRoot: "/repo", repoRootDisplay: "repo", firstRunPending: false, defaultModel: "opus", defaultEffort: "default", defaultAgentProvider: .claude, authMode: .subscription, operatorLanguage: .en)))
        server.stub("GET", "/api/repos", status: 200, json: Data(#"{"repos":[],"recentWindowDays":7}"#.utf8))
        for path in ["/api/automerge", "/api/drain", "/api/manual-steps/outstanding"] {
            server.stub("GET", path, status: 200, json: Data("[]".utf8))
        }
        server.on("GET", "/api/queues") { request in
            SettingsFakeResponse(body: request.query == "host=mac" ? bodies["/api/queues"]! : Data("{}".utf8))
        }
        defer { actions.teardown(); plan.teardown(); merge.teardown(); store.stop(); app.teardown(); server.tearDown() }
        #expect(await eventually { actions.recap(for: "remote")?.headline == "Owner recap" && plan.gates["remote"] != nil && merge.snapshot.queues["remote"] != nil })
        await actions.refresh(); await plan.refresh(); await merge.refresh()
        #expect(actions.recap(for: "remote")?.headline == "Owner recap")
        #expect(plan.gates["remote"]?.summary == "Owner plan")
        #expect(merge.snapshot.queues["remote"]?.approved == true)

        // Failed source reads retain values, and mark the owner stale independently of Mo.
        for path in bodies.keys { server.stub("GET", path, status: 503, json: Data("{}".utf8)) }
        await actions.refresh(); await plan.refresh(); await merge.refresh()
        #expect(actions.recap(for: "remote")?.headline == "Owner recap")
        #expect(plan.gates["remote"] != nil && merge.snapshot.queues["remote"] != nil)
        #expect(store.remoteSnapshotFailures["recaps"] == ["mac"])
        let newer = Data(#"{"id":"remote","recap":{"sessionId":"remote","state":"ready","headline":"Pushed recap","body":"b","openItems":[],"updatedAt":2}}"#.utf8)
        store.apply(.mirrored(host: session.host!, event: .unknown(name: "session:recap", payload: newer)))
        #expect(await eventually { actions.recap(for: "remote")?.headline == "Pushed recap" })
        // Reconnection revalidates even if there was no recap/plan/queue event.
        for path in bodies.keys {
            server.stub("GET", path, status: 200, json: Data((path.hasSuffix("inflight") ? "[]" : "{}").utf8))
        }
        let snapshot = RemoteSessionsEvent(instanceId: "mac", sessions: [session])
        store.apply(.unknown(name: "remote:sessions", payload: try JSONEncoder().encode(snapshot)))
        #expect(await eventually { actions.recap(for: "remote") == nil && plan.gates["remote"] == nil && merge.snapshot.queues["remote"] == nil })
        server.stub("GET", "/api/sessions", status: 200, json: try JSONEncoder().encode([PreviewData.session(id: "local")]))
        store.apply(.unknown(name: "remote:sessions", payload: try JSONEncoder().encode(RemoteSessionsEvent(instanceId: "mac", sessions: []))))
        #expect(await eventually { store.remoteSessions.isEmpty && actions.recaps.isEmpty && plan.gates.isEmpty })
    }

    @Test func steeringMapsOwnerCheckoutToMosProjectBySlugOnly() {
        var remote = PreviewData.session(id: "remote")
        remote.host = .init(instanceId: "mac", name: "MacBook", platform: .init(known: .macos))
        remote.repoPath = "/mac/different-name"; remote.remoteSlug = "Org/Project"
        let mo = Repo(name: "project-on-mo", path: "/mo/project", display: "project", realPath: "/mo/repo", isFork: false, remoteSlug: "org/project", hidden: false)
        #expect(SteerScope.repoNames(repos: [mo], sessions: [remote])[remote.repoPath] == "project-on-mo")
        remote.remoteSlug = nil
        #expect(SteerScope.repoNames(repos: [mo], sessions: [remote])[remote.repoPath] == nil)
        remote.remoteSlug = "org/project"
        let ambiguous = Repo(name: "another-project", path: "/mo/second", display: "project", realPath: "/mo/repo", isFork: false, remoteSlug: "org/project", hidden: false)
        #expect(SteerScope.repoNames(repos: [mo, ambiguous], sessions: [remote])[remote.repoPath] == nil)
    }
}
}
