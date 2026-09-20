import Foundation
import Testing
@testable import ShepherdKit

@Suite("ShepherdClient composer")
struct ShepherdClientComposeTests {
    private func makeClient(_ server: FakeShepherdServer) throws -> ShepherdClient {
        let credentials = InMemoryCredentialStore()
        try credentials.save(StoredCredential(token: "shp_test", tokenId: "tok"), for: "k")
        let profile = ServerProfile(name: "fake", baseURL: server.baseURL, mode: .local, credentialKey: "k")
        return try ShepherdClient(profile: profile, credentials: credentials, urlSession: server.urlSession())
    }

    @Test("four issues decode with viewer and the repo query reaches the wire")
    func listing() async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        let rows = (412...415).map { number in
            """
            {"number":\(number),"title":"Issue","body":"Details","url":"https://example.test/i/\(number)",
            "labels":["bug"],"labelColors":{"bug":"#d73a4a"},"createdAt":1800000000000,
            "assignees":[],"author":"operator","blockedBy":[999]}
            """
        }.joined(separator: ",")
        server.stub("GET", "/api/issues", status: 200, json: Data("""
            {"slug":"owner/repo","webUrl":"https://example.test","issues":[\(rows)],
            "viewer":"operator","lightweight":false}
            """.utf8))
        let result = try await makeClient(server).issues(repoPath: "/repos/a b")
        #expect(result.issues.map(\.number) == [412, 413, 414, 415])
        #expect(result.viewer == "operator")
        #expect(result.issues[0].blockedBy == [999])
        let request = try #require(server.requests().last)
        let query = URLComponents(string: "http://fake/?\(request.query ?? "")")?.queryItems
        #expect(query?.first(where: { $0.name == "repo" })?.value == "/repos/a b")
    }

    @Test("fetch_failed remains a successful listing")
    func fetchFailed() async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.stub("GET", "/api/issues", status: 200, json: Data("""
            {"slug":"owner/repo","webUrl":"https://example.test","issues":[],"viewer":null,
            "error":"fetch_failed","attempts":[{"transport":"rest","reason":"future_reason","detail":"oops"}]}
            """.utf8))
        let result = try await makeClient(server).issues(repoPath: "/repo")
        #expect(result.issues.isEmpty)
        #expect(result.error == "fetch_failed")
        #expect(result.attempts?.first?.reason.rawValue == "future_reason")
    }

    @Test("unknown command scopes and kinds survive decoding")
    func commands() async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.stub("GET", "/api/commands", status: 200, json: Data("""
            {"commands":[{"name":"ship","description":"Ship","scope":"future_scope","kind":"future_kind"}]}
            """.utf8))
        let result = try await makeClient(server).commands(repoPath: "/repo", provider: .codex)
        #expect(result.commands.first?.scope.rawValue == "future_scope")
        #expect(result.commands.first?.kind?.rawValue == "future_kind")
        #expect(server.requests().last?.query?.contains("provider=codex") == true)
    }

    @Test("epic parent and child numbers decode")
    func epics() async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.stub("GET", "/api/epics", status: 200, json: Data("""
            {"epics":[{"number":412,"title":"Parent"}],"subIssues":[413,414]}
            """.utf8))
        let result = try await makeClient(server).epics(repoPath: "/repo")
        #expect(result.epics.first?.number == 412)
        #expect(result.subIssues == [413, 414])
    }

    @Test func branchesAndStatusEncodeQueriesAndDecodeNullableDefaults() async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.stub("GET", "/api/branches", status: 200, json: Data(#"{"branches":[],"current":"trunk","default":null}"#.utf8))
        server.stub("GET", "/api/branch-status", status: 200, json: Data(#"{"behind":2,"ahead":1,"diverged":true,"hasUpstream":true,"localExists":false}"#.utf8))
        let client = try makeClient(server)
        let listing = try await client.branches(repoPath: "/repos/a b")
        #expect(listing.current == "trunk")
        #expect(listing._default == nil)
        #expect(listing.branches.isEmpty)
        let status = try await client.branchStatus(repoPath: "/repos/a b", branch: "feature/my-branch")
        #expect(status.behind == 2 && status.ahead == 1 && status.diverged)
        #expect(status.hasUpstream && !status.localExists)
        for request in server.requests() {
            let query = URLComponents(string: "http://fake/?\(request.query ?? "")")?.queryItems
            #expect(query?.first(where: { $0.name == "repo" })?.value == "/repos/a b")
        }
        let query = URLComponents(string: "http://fake/?\(server.requests().last?.query ?? "")")?.queryItems
        #expect(query?.first(where: { $0.name == "branch" })?.value == "feature/my-branch")
    }

    @Test func initialCommitUsesTheDeclaredBody() async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.stub("POST", "/api/repos/init-empty-commit", status: 200, json: Data(#"{"branch":"trunk"}"#.utf8))
        let result = try await makeClient(server).initEmptyCommit(repoPath: "/repo", branch: "trunk")
        #expect(result.branch == "trunk")
        let request = try #require(server.requests().last)
        let body = try JSONDecoder().decode(Components.Schemas.InitEmptyCommitRequest.self, from: #require(request.body))
        #expect(body.repo == "/repo" && body.branch == "trunk")
    }

    @Test(arguments: ["branches", "branch-status", "repos/init-empty-commit"], [400, 401, 422, 503])
    func branchErrors(route: String, status: Int) async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        let repair = route == "repos/init-empty-commit"
        server.stub(repair ? "POST" : "GET", "/api/\(route)", status: status, json: try Fixtures.errorJSON("bad"))
        let client = try makeClient(server)
        let operation = repair ? "initEmptyCommit" : route == "branches" ? "listBranches" : "getBranchStatus"
        let expected: ShepherdError = status == 400 ? .badRequest("bad") : status == 401 ? .unauthenticated
            : repair && status == 422 ? .unprocessable("bad")
            : .contractMismatch(route: operation, underlying: "undocumented status \(status)")
        await #expect(throws: expected) {
            if repair { _ = try await client.initEmptyCommit(repoPath: "/repo", branch: "main") }
            else if route == "branches" { _ = try await client.branches(repoPath: "/repo") }
            else { _ = try await client.branchStatus(repoPath: "/repo", branch: "main") }
        }
    }

    @Test("all composer methods map documented errors and unknown statuses", arguments: ["issues", "commands", "epics"], [400, 401, 503])
    func errors(route: String, status: Int) async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.stub("GET", "/api/\(route)", status: status, json: try Fixtures.errorJSON("bad"))
        let client = try makeClient(server)
        let operation = ["issues": "listIssues", "commands": "listCommands", "epics": "listEpics"][route]!
        let expected: ShepherdError = status == 400 ? .badRequest("bad") : status == 401
            ? .unauthenticated : .contractMismatch(route: operation, underlying: "undocumented status 503")
        await #expect(throws: expected) {
            switch route {
            case "issues": _ = try await client.issues(repoPath: "/repo")
            case "commands": _ = try await client.commands(repoPath: "/repo", provider: .claude)
            default: _ = try await client.epics(repoPath: "/repo")
            }
        }
    }
}
