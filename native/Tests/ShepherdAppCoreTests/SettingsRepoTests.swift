import Foundation
import Synchronization
import Testing
import ShepherdKit
@testable import ShepherdAppCore

extension CoreSeamTests {
@MainActor struct SettingsRepoTests {
    private func model() -> SettingsModel {
        SettingsModel(reads: .init(snapshot: { throw ShepherdError.notFound }))
    }
    private func client(_ server: SettingsFakeServer) throws -> ShepherdClient {
        try ShepherdClient(profile: .init(name: "fixture", baseURL: server.baseURL, mode: .local),
            credentials: InMemoryCredentialStore(), urlSession: server.urlSession())
    }
    @Test func confirmationCancellationAndRequestTargets() async throws {
        let server = SettingsFakeServer(); defer { server.tearDown() }
        let client = try client(server), model = model(); defer { model.teardown() }
        model.repo = "/srv/old-root/project"
        model.forkTarget = "operator/new-project"
        model.directories = .init(path: "/srv/new-root", display: "new-root", entries: [])
        let cases = [("pull", "POST", "/api/repos/pull", "repo", model.repo),
                     ("sync", "POST", "/api/repos/sync-fork", "repo", model.repo),
                     ("fork", "POST", "/api/repos/fork", "target", model.forkTarget),
                     ("root", "PUT", "/api/settings", "repoRoot", "/srv/new-root")]
        for (action, method, path, key, target) in cases {
            server.on(method, path) { request in
                let data = try #require(request.body)
            let body = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
                #expect(body[key] as? String == target)
                return SettingsFakeResponse(statusCode: 400, body: Data(#"{"error":"fixture refusal"}"#.utf8))
            }
            let before = server.requests().count
            model.requestWorkspaceAction(action)
            #expect(model.workspaceTarget == target)
            #expect(server.requests().count == before)
            model.cancelWorkspaceAction()
            model.applyWorkspaceAction(client: client)
            #expect(server.requests().count == before)
            model.requestWorkspaceAction(action)
            model.applyWorkspaceAction(client: client)
            await settingsEventually { !model.busy }
            #expect(server.requests().count == before + 1)
            #expect(model.workspaceAction == nil)
        }
        model.repo = ""
        model.requestWorkspaceAction("root")
        #expect(model.workspaceTarget == "/srv/new-root")
    }
    @Test func configAndExplicitNullRolesReachTheServerOnlyAfterConfirmation() async throws {
        let server = SettingsFakeServer(); defer { server.tearDown() }
        let client = try client(server), model = model(); defer { model.teardown() }
        model.repo = "/srv/repo with spaces"
        server.on("PUT", "/api/repo-config") { request in
            #expect(URLComponents(string: "http://fixture/?" + (request.query ?? ""))?.queryItems?.first?.value == "/srv/repo with spaces")
            let data = try #require(request.body)
            let body = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            #expect(body["autoDrainEnabled"] as? Bool == true)
            #expect(body["automationConfirmed"] as? Bool == true)
            #expect(body.count == 2)
            return SettingsFakeResponse(statusCode: 400, body: Data(#"{"error":"fixture refusal"}"#.utf8))
        }
        model.requestWorkspaceAction("config", config: .init(autoDrainEnabled: true))
        #expect(server.requests().isEmpty)
        model.applyWorkspaceAction(client: client)
        await settingsEventually { !model.busy }
        server.on("PUT", "/api/repo-roles") { request in
            #expect(URLComponents(string: "http://fixture/?" + (request.query ?? ""))?.queryItems?.first?.value == "/srv/repo with spaces")
            let data = try #require(request.body)
            let body = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            #expect(body["reviewer"] is NSNull); #expect(body["merger"] is NSNull)
            return SettingsFakeResponse(body: Data(#"{"roles":{"reviewer":null,"merger":null},"me":null}"#.utf8))
        }
        model.requestWorkspaceAction("roles")
        #expect(server.requests().count == 1)
        model.applyWorkspaceAction(client: client)
        await settingsEventually { !model.busy }
        #expect(server.requests().count == 2)
        #expect(model.roles != nil)
    }
    @Test func failedRecoveryClearsRolesAndDrafts() async throws {
        let server = SettingsFakeServer(); defer { server.tearDown() }
        let client = try client(server), model = model(); defer { model.teardown() }
        model.repo = "/srv/project"
        model.roles = .init(roles: .init(reviewer: "stale", merger: "stale"))
        server.on("PUT", "/api/repo-roles") { _ in
            SettingsFakeResponse(statusCode: 502, body: Data(#"{"roles":{"reviewer":null,"merger":null},"me":null,"pushError":"rejected"}"#.utf8))
        }
        server.on("GET", "/api/repo-roles") { _ in
            SettingsFakeResponse(statusCode: 400, body: Data(#"{"error":"refresh failed"}"#.utf8))
        }
        model.requestWorkspaceAction("roles"); model.applyWorkspaceAction(client: client)
        await settingsEventually { !model.busy }
        #expect(model.roles == nil); #expect(model.reviewer.isEmpty); #expect(model.merger.isEmpty)
        #expect(model.error != nil)
    }
    @Test(arguments: [200, 400]) func confirmedConfigSaveAdoptsOnlyItsNormalizedDraft(status: Int) async throws {
        let server = SettingsFakeServer(); defer { server.tearDown() }
        let client = try client(server), model = model(); defer { model.teardown() }
        let config = Data(#"{"criticEnabled":false,"criticAllPrs":false,"criticSmellLensEnabled":false,"autoAddressEnabled":false,"autopilotEnabled":false,"planGateEnabled":false,"autoDrainEnabled":false,"autoMergeEnabled":false,"buildQueueEnabled":false,"draftMode":false,"manualStepsIssueEnabled":false,"preWarmEpicLandingCi":false,"mergeWithoutCi":false,"epicStacksEnabled":false,"sharedBrowserEnabled":false,"claudeAiConnectorsEnabled":false,"hidden":false,"pinned":false,"signoffAuthority":"human","maxAuto":1,"autoLabel":"auto","usageCeilingPct":80,"sandboxProfile":"default","defaultModel":"inherit","defaultEffort":"default","egressExtraHosts":[],"browserAllowedHosts":[],"repoMode":"forge","previewStartScript":null,"previewStartCommand":null,"previewOpenMode":"browser"}"#.utf8)
        model.repo = "/srv/project"
        model.repoConfig = try JSONDecoder().decode(RepoConfig.self, from: config)
        let draft = SettingsRepoTextDraft(), other = SettingsRepoTextDraft()
        draft.text = "80.5"; other.text = "unsaved model alias"
        server.on("PUT", "/api/repo-config") { request in
            let data = try #require(request.body)
            let body = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            #expect(body["usageCeilingPct"] as? Double == 80.5)
            return SettingsFakeResponse(statusCode: status,
                body: status == 200 ? config : Data(#"{"error":"rejected"}"#.utf8))
        }
        func submit() {
            draft.submit { text, adopt in
                model.requestWorkspaceAction("config", config: .init(usageCeilingPct: Double(text)),
                    configCommit: { adopt(String($0.usageCeilingPct)) })
            }
        }
        submit()
        model.cancelWorkspaceAction(); model.applyWorkspaceAction(client: client)
        #expect(server.requests().isEmpty)
        #expect(draft.text == "80.5")
        submit(); model.applyWorkspaceAction(client: client)
        await settingsEventually { !model.busy }
        #expect(server.requests().count == 1)
        #expect(model.repoConfig?.usageCeilingPct == 80)
        #expect(draft.text == (status == 200 ? "80.0" : "80.5"))
        #expect(other.text == "unsaved model alias")
    }
    @Test func repoSettingsChoicesSaveAndShowTheReloadedConfig() async throws {
        let server = SettingsFakeServer(); defer { server.tearDown() }
        let client = try client(server), model = model(); defer { model.teardown() }
        let saved = Data(#"{"criticEnabled":false,"criticAllPrs":false,"criticSmellLensEnabled":false,"autoAddressEnabled":false,"autopilotEnabled":false,"planGateEnabled":false,"autoDrainEnabled":false,"autoMergeEnabled":true,"buildQueueEnabled":false,"draftMode":false,"manualStepsIssueEnabled":false,"preWarmEpicLandingCi":false,"mergeWithoutCi":false,"epicStacksEnabled":false,"sharedBrowserEnabled":false,"claudeAiConnectorsEnabled":false,"hidden":false,"pinned":false,"signoffAuthority":"either","maxAuto":1,"autoLabel":"auto","usageCeilingPct":80,"sandboxProfile":"autonomous","agentProvider":"codex","defaultModel":"gpt-6.1-sol","defaultEffort":"ultra","egressExtraHosts":["registry.example.com"],"browserAllowedHosts":[],"repoMode":"github","previewOpenMode":"tab"}"#.utf8)
        model.repo = "/srv/project"
        server.on("PUT", "/api/repo-config") { request in
            let data = try #require(request.body)
            let body = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            #expect(body["automationConfirmed"] as? Bool == true)
            return SettingsFakeResponse(body: saved)
        }
        let patches: [RepoConfigPatch] = [
            .init(agentProvider: "codex"), .init(defaultModel: "gpt-6.1-sol"), .init(defaultEffort: "ultra"),
            .init(sandboxProfile: "autonomous"), .init(egressExtraHosts: ["registry.example.com"]),
            .init(previewOpenMode: "tab"), RepoSettingsForm.mergePatch(.auto),
        ]
        for patch in patches {
            model.requestWorkspaceAction("config", config: patch)
            model.applyWorkspaceAction(client: client)
            await settingsEventually { !model.busy }
        }
        #expect(server.requests().count == patches.count)
        let last = try #require(server.requests().last?.body)
        let merge = try #require(JSONSerialization.jsonObject(with: last) as? [String: Any])
        #expect(merge["draftMode"] as? Bool == false); #expect(merge["autoMergeEnabled"] as? Bool == true)
        let config = try #require(model.repoConfig)
        #expect(config.agentProvider == "codex")
        #expect(RepoSettingsForm.effectiveProvider(config, global: .claude) == .codex)
        #expect(RepoSettingsForm.shownModel(config.defaultModel, provider: .codex) == "gpt-6.1-sol")
        #expect(RepoSettingsForm.shownEffort(config.defaultEffort, provider: .codex) == "ultra")
        #expect(RepoSettingsForm.shownSandbox(config) == "autonomous")
        #expect(RepoSettingsForm.showsEgressHosts(config))
        #expect(config.egressExtraHosts == ["registry.example.com"])
        #expect(RepoSettingsForm.effectiveMergeMode(config) == .auto)
        #expect(config.previewOpenMode == "tab")
    }
    @Test func failedRoleSaveRefreshesDraftsBeforeRetry() async throws {
        let server = SettingsFakeServer(); defer { server.tearDown() }
        let client = try client(server), model = model(); defer { model.teardown() }
        model.repo = "/srv/project"; model.reviewer = "new-reviewer"; model.merger = "stale-merger"
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        server.on("PUT", "/api/repo-roles") { _ in
            SettingsFakeResponse(statusCode: 502, body: Data(#"{"roles":{"reviewer":"new-reviewer","merger":"stale-merger"},"me":null,"pushError":"push rejected"}"#.utf8))
        }
        server.on("GET", "/api/repo-roles") { _ in
            #expect(release.wait(timeout: .now() + 10) == .success)
            return SettingsFakeResponse(body: Data(#"{"roles":{"reviewer":"new-reviewer","merger":"other-operator"},"me":null}"#.utf8))
        }
        model.requestWorkspaceAction("roles"); model.applyWorkspaceAction(client: client)
        await settingsEventually { server.requests().contains { $0.method == "GET" } || !model.busy }
        #expect(model.busy, "Save stays disabled while authoritative roles refresh")
        release.signal()
        await settingsEventually { !model.busy }
        #expect(model.error != nil)
        #expect(model.reviewer == "new-reviewer"); #expect(model.merger == "other-operator")
        server.on("PUT", "/api/repo-roles") { request in
            let data = try #require(request.body)
            let body = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            #expect(body["merger"] as? String == "other-operator")
            return SettingsFakeResponse(body: Data(#"{"roles":{"reviewer":"retry","merger":"other-operator"},"me":null}"#.utf8))
        }
        model.reviewer = "retry"
        model.requestWorkspaceAction("roles"); model.applyWorkspaceAction(client: client)
        await settingsEventually { !model.busy }
        #expect(model.roles?.roles.reviewer == "retry")
        #expect(server.requests().map(\.method) == ["PUT", "GET", "PUT"])
    }
}
}

@MainActor func settingsEventually(_ condition: () -> Bool, sourceLocation: SourceLocation = #_sourceLocation) async {
    let deadline = ContinuousClock.now + .seconds(5)
    while !condition(), ContinuousClock.now < deadline { await Task.yield() }
    #expect(condition(), "Condition did not settle", sourceLocation: sourceLocation)
}
