import Foundation
import Testing
@testable import ShepherdKit

struct ShepherdClientRepoProjectTests {
    private func client(_ server: FakeShepherdServer) throws -> ShepherdClient {
        try ShepherdClient(profile: .init(name: "coordinator", baseURL: server.baseURL, mode: .local),
            credentials: InMemoryCredentialStore(), urlSession: server.urlSession())
    }
    static let rules = #"{"criticEnabled":false,"criticAllPrs":false,"criticSmellLensEnabled":false,"autoAddressEnabled":false,"autopilotEnabled":false,"planGateEnabled":false,"autoDrainEnabled":false,"autoMergeEnabled":false,"buildQueueEnabled":false,"draftMode":false,"signoffAuthority":"either","manualStepsIssueEnabled":false,"preWarmEpicLandingCi":false,"epicStacksEnabled":false,"autoLabel":"shepherd","defaultModel":"inherit","defaultEffort":"inherit"}"#

    @Test func projectReadUsesRemoteIdentityAndKeepsOfflineMachines() async throws {
        let server = FakeShepherdServer(); defer { server.tearDown() }
        server.on("GET", "/api/repo-config/project") { request in
            #expect(request.query?.contains("remoteSlug=owner%2Frepo") == true || request.query?.contains("remoteSlug=owner/repo") == true)
            return FakeResponse(body: Data(#"{"remoteSlug":"owner/repo","complete":false,"referenceInstanceId":"mac","rules":null,"repoConfigCommit":null,"leitrechner":null,"machines":[{"instanceId":"linux","name":"Linux","membership":"present","reachable":false,"reason":"disconnected","config":null}],"differences":{"applicable":true,"complete":false,"unavailableInstanceIds":["linux"],"fields":[],"multipleAutoDrain":[]}}"#.utf8))
        }
        let project = try await client(server).getRepoConfigProject(remoteSlug: "owner/repo")
        #expect(project.machines.count == 1)
        #expect(project.machines[0].reachable == false)
        #expect(!project.complete)
    }

    @Test func projectWriteSendsTwoRulesInOneRequestToExplicitMachine() async throws {
        let server = FakeShepherdServer(); defer { server.tearDown() }
        server.on("PUT", "/api/repo-config/project") { request in
            #expect(request.query?.contains("instanceId=mac") == true)
            #expect(request.query?.contains("host=") == false)
            let data = try #require(request.body)
            let body = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            let rules = try #require(body["rules"] as? [String: Bool])
            #expect(rules == ["criticEnabled": true, "planGateEnabled": true])
            return FakeResponse(body: Data((#"{"rules": latest,"repoConfigCommit":"abc123","leitrechner":null,"notifications":[{"instanceId":"linux","name":"Linux","ok":false,"reason":"disconnected"}]}"#.replacingOccurrences(of: "latest", with: Self.rules)).utf8))
        }
        let result = try await client(server).putRepoConfigProject(remoteSlug: "owner/repo", instanceID: "mac",
            body: .init(rules: .init(criticEnabled: true, planGateEnabled: true)))
        #expect(result.repoConfigCommit == "abc123")
        #expect(result.notifications.first?.ok == false)
    }

    @Test func protectedRuleWriteKeepsEffectiveRulesUntilMerge() async throws {
        let server = FakeShepherdServer(); defer { server.tearDown() }
        server.on("PUT", "/api/repo-config/project") { _ in
            let json = #"{"rules":RULES,"repoConfigCommit":"previous","leitrechner":null,"notifications":[],"pendingRepoConfig":{"number":42,"url":"https://host/pr/42","changes":{"criticEnabled":true}}}"#
                .replacingOccurrences(of: "RULES", with: Self.rules)
            return FakeResponse(body: Data(json.utf8))
        }
        let result = try await client(server).putRepoConfigProject(remoteSlug: "owner/app", instanceID: "mac",
            body: .init(rules: .init(criticEnabled: true)))
        #expect(result.rules.criticEnabled == false)
        #expect(result.repoConfigCommit == "previous")
        #expect(result.pendingRepoConfig?.number == 42)
        #expect(result.notifications.isEmpty)
    }

    @Test func responsibilitiesUseTheSameCoordinatorAndPreserveExplicitNull() async throws {
        let server = FakeShepherdServer(); defer { server.tearDown() }
        server.on("GET", "/api/repo-config/roles") { request in
            #expect(request.query?.contains("instanceId=mac") == true)
            #expect(request.query?.contains("repo=") == false)
            return FakeResponse(body: Data(#"{"roles":{"reviewer":"reviewer","merger":null},"me":null}"#.utf8))
        }
        server.on("PUT", "/api/repo-config/roles") { request in
            let data = try #require(request.body)
            let body = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            #expect(body["reviewer"] is NSNull)
            #expect(body["merger"] as? String == "merger")
            return FakeResponse(body: Data(#"{"roles":{"reviewer":null,"merger":"merger"},"me":null}"#.utf8))
        }
        let api = try client(server)
        #expect(try await api.getRepoConfigRoles(remoteSlug: "owner/app", instanceID: "mac").roles.reviewer == "reviewer")
        let result = try await api.putRepoConfigRoles(remoteSlug: "owner/app", instanceID: "mac",
            body: .values(reviewer: nil, merger: "merger"))
        #expect(result.roles.reviewer == nil)
        #expect(result.roles.merger == "merger")
    }

    @Test func machineFailureRetainsTheReasonAndNeverFallsBack() async throws {
        let server = FakeShepherdServer(); defer { server.tearDown() }
        server.on("PUT", "/api/repo-config/machine") { request in
            #expect(request.query?.contains("instanceId=linux") == true)
            let data = try #require(request.body)
            let body = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            #expect(body.count == 1)
            #expect(body["maxAuto"] as? Int == 3)
            return FakeResponse(statusCode: 502, body: Data(#"{"error":"machine is not reachable","code":"machine_unreachable"}"#.utf8))
        }
        await #expect(throws: ShepherdError.upstreamFailure(code: "machine_unreachable", message: "machine is not reachable")) {
            _ = try await client(server).putRepoConfigMachine(remoteSlug: "owner/repo", instanceID: "linux", body: .init(maxAuto: 3))
        }
    }
}
