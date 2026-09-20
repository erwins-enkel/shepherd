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

    @Test func correlatedCreateUsesHeaderAndCancelMapsOutcome() async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.stub("POST", "/api/sessions", status: 401, json: try Fixtures.errorJSON("unauthorized"))
        server.stub("POST", "/api/spawns/compose-test-id/cancel", status: 200,
                    json: Data(#"{"canceled":false}"#.utf8))
        let client = try makeClient(server)
        await #expect(throws: ShepherdError.unauthenticated) {
            _ = try await client.createSession(.init(repoPath: "/repo", baseBranch: "main", prompt: "Fix",
                                                     agentProvider: .claude), spawnID: "compose-test-id")
        }
        let request = try #require(server.requests().first)
        #expect(request.headers.first { $0.key.lowercased() == "x-shepherd-spawn-id" }?.value == "compose-test-id")
        let body = try #require(request.body)
        let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(json["spawnId"] == nil)
        #expect(try await client.cancelSpawn(id: "compose-test-id") == false)
    }

    @Test func shapeAndBriefUseGeneratedPayloads() async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        let roundJSON = #"{"draft":{"problem":"Problem","outcome":"Outcome","constraints":[],"nonGoals":[]},"block":{"type":"question-form","id":"shape-questions","questions":[]}}"#
        server.stub("POST", "/api/shape", status: 200, json: Data(roundJSON.utf8))
        server.stub("POST", "/api/shape/brief", status: 200, json: Data(#"{"brief":"Whole brief"}"#.utf8))
        let client = try makeClient(server)
        let round = try await client.shapeTask(.init(repoPath: "/repo", prompt: "Rough", provider: .codex))
        #expect(round.draft.problem == "Problem")
        #expect(round.block.questions.isEmpty)
        let brief = try await client.shapeBrief(.init(draft: round.draft, block: round.block,
            answers: [.init(blockId: round.block.id, questionId: "q", optionIndices: [1])]))
        #expect(brief == "Whole brief")
        let requests = server.requests()
        #expect(requests.map(\.path) == ["/api/shape", "/api/shape/brief"])
        let shapeBody = try #require(requests[0].body)
        let shape = try #require(JSONSerialization.jsonObject(with: shapeBody) as? [String: Any])
        #expect(shape["repoPath"] as? String == "/repo")
        #expect(shape["prompt"] as? String == "Rough")
        #expect(shape["provider"] as? String == "codex")
        #expect(shape["model"] == nil || shape["model"] is NSNull)
        let briefBody = try #require(requests[1].body)
        let payload = try #require(JSONSerialization.jsonObject(with: briefBody) as? [String: Any])
        let answers = try #require(payload["answers"] as? [[String: Any]])
        #expect(answers.first?["optionIndices"] as? [Int] == [1])
    }

    @Test(arguments: [400, 401, 422, 503])
    func shapeMapsErrors(_ status: Int) async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.stub("POST", "/api/shape", status: status, json: try Fixtures.errorJSON("unavailable"))
        let client = try makeClient(server)
        if status == 422 || status == 503 {
            await #expect(throws: ComposeShapeError.failed("unavailable")) {
                _ = try await client.shapeTask(.init(repoPath: "/repo", prompt: "Rough", provider: .claude))
            }
        } else {
            await #expect(throws: status == 401 ? ShepherdError.unauthenticated : .badRequest("unavailable")) {
                _ = try await client.shapeTask(.init(repoPath: "/repo", prompt: "Rough", provider: .claude))
            }
        }
    }

    @Test(arguments: ["empty-prompt", "spawn-failed", "timeout", "unavailable"])
    func shapePreservesEveryFailureSlug(_ slug: String) async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.stub("POST", "/api/shape", status: 422, json: try Fixtures.errorJSON(slug))
        let client = try makeClient(server)
        await #expect(throws: ComposeShapeError.failed(slug)) {
            _ = try await client.shapeTask(.init(repoPath: "/repo", prompt: "Rough", provider: .codex, model: "gpt-6-astra"))
        }
    }

    @Test(arguments: [400, 401])
    func briefMapsErrors(_ status: Int) async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.stub("POST", "/api/shape/brief", status: status, json: try Fixtures.errorJSON("invalid round"))
        let client = try makeClient(server)
        await #expect(throws: status == 401 ? ShepherdError.unauthenticated : .badRequest("invalid round")) {
            _ = try await client.shapeBrief(.init(
                draft: .init(problem: "P", outcome: "O", constraints: [], nonGoals: []),
                block: .init(_type: .questionForm, id: "shape-questions", questions: []), answers: []))
        }
    }

    @Test(arguments: ["attachment bytes", ""])
    func uploadUsesGeneratedMultipartWithFileNameAndExactBytes(_ content: String) async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.stub("POST", "/api/uploads", status: 200, json: Data(#"{"path":"/staged/abc.txt"}"#.utf8))
        let result = try await makeClient(server).uploadFile(data: Data(content.utf8), filename: "original.txt")
        #expect(result.path == "/staged/abc.txt")
        let request = try #require(server.requests().last)
        #expect(request.method == "POST" && request.path == "/api/uploads")
        #expect(request.query == nil || request.query == "")
        let contentType = request.headers.first { $0.key.lowercased() == "content-type" }?.value
        #expect(contentType?.hasPrefix("multipart/form-data; boundary=") == true)
        let body = String(decoding: try #require(request.body), as: UTF8.self)
        #expect(body.contains("name=\"file\""))
        #expect(body.contains("filename=\"original.txt\""))
        #expect(body.contains("\r\n\r\n" + content + "\r\n"))
    }

    @Test func uploadProgressTracksFileBytesThroughGeneratedMultipart() async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.stub("POST", "/api/uploads", status: 200, json: Data(#"{"path":"/staged/bytes"}"#.utf8))
        let progress = UploadProgressRecorder()
        let bytes = Data(repeating: 7, count: 150_000)
        let result = try await makeClient(server).uploadFile(data: bytes, filename: "bytes.bin") {
            await progress.record($0)
        }
        #expect(result.path == "/staged/bytes")
        let values = await progress.values
        #expect(values.contains { $0 > 0 && $0 < bytes.count })
        #expect(values.last == bytes.count)
        #expect(values == values.sorted())
        let request = try #require(server.requests().last)
        #expect(request.headers.first { $0.key.lowercased() == "authorization" }?.value == "Bearer shp_test")
        #expect(try #require(request.body).range(of: bytes) != nil)
    }

    @Test func uploadProgressFollowsConsumerDemandAndStopsOnCancellation() async throws {
        let progress = UploadProgressRecorder()
        let sequence = ComposeUploadBytes(data: Data(repeating: 1, count: 150_000), progress: {
            await progress.record($0)
        })
        var iterator = sequence.makeAsyncIterator()
        #expect(await progress.values.isEmpty)
        let first = try #require(try await iterator.next())
        #expect(first.count > 0 && first.count < 150_000)
        // Returning a chunk is not progress until the consumer asks for the next one.
        #expect(await progress.values.isEmpty)
        _ = try await iterator.next()
        #expect(await progress.values == [first.count])
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            var cancelled = sequence.makeAsyncIterator()
            await #expect(throws: CancellationError.self) { _ = try await cancelled.next() }
        }
        await task.value
        #expect(await progress.values == [first.count])
    }

    @Test func uploadEscapesUntrustedMultipartFilename() async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.stub("POST", "/api/uploads", status: 200, json: Data(#"{"path":"/staged/test"}"#.utf8))
        _ = try await makeClient(server).uploadFile(data: Data([1]), filename: "a%\"\r\n.txt")
        let body = String(decoding: try #require(server.requests().last?.body), as: UTF8.self)
        #expect(body.contains("filename=\"a%25%22%0D%0A.txt\""))
    }

    @Test(arguments: [false, true])
    func upload401OnlyInvalidatesTheCredentialActuallyRejected(replaceDuringUpload: Bool) async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        let credentials = InMemoryCredentialStore()
        let rejected = StoredCredential(token: "rejected", tokenId: "old")
        // Even a fresh credential with the same token string must survive a stale 401.
        let replacement = StoredCredential(token: "rejected", tokenId: "new")
        try credentials.save(rejected, for: "upload")
        server.on("POST", "/api/uploads") { request in
            #expect(request.headers.first { $0.key.lowercased() == "authorization" }?.value == "Bearer rejected")
            if replaceDuringUpload { try credentials.save(replacement, for: "upload") }
            return FakeResponse(statusCode: 401, body: Data(#"{"error":"unauthorized"}"#.utf8))
        }
        server.on("GET", "/api/settings") { _ in throw URLError(.notConnectedToInternet) }
        let client = try ShepherdClient(profile: .init(name: "upload", baseURL: server.baseURL,
                                                       mode: .local, credentialKey: "upload"),
                                        credentials: credentials, urlSession: server.urlSession())
        let progress = UploadProgressRecorder()
        await #expect(throws: ShepherdError.unauthenticated) {
            _ = try await client.uploadFile(data: Data([1]), filename: "test") { await progress.record($0) }
        }
        #expect(try credentials.load(for: "upload") == (replaceDuringUpload ? replacement : nil))
        #expect(server.requests().map(\.path) == ["/api/uploads"])
    }

    @Test(arguments: [400, 401, 404, 413, 503])
    func uploadMapsEveryDeclaredError(_ status: Int) async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.stub("POST", "/api/uploads", status: status, json: try Fixtures.errorJSON("bad"))
        let client = try makeClient(server)
        if status == 413 {
            await #expect(throws: ComposeUploadError.fileTooLarge("bad")) {
                _ = try await client.uploadFile(data: Data(), filename: "empty.txt")
            }
        } else {
            let expected: ShepherdError = status == 400 ? .badRequest("bad") : status == 401 ? .unauthenticated
                : status == 404 ? .notFound : .contractMismatch(route: "uploadFile", underlying: "undocumented status 503")
            await #expect(throws: expected) {
                _ = try await client.uploadFile(data: Data(), filename: "empty.txt")
            }
        }
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
            "error":"fetch_failed","attempts":[{"transport":"future_transport","reason":"future_reason","detail":"oops"}]}
            """.utf8))
        let result = try await makeClient(server).issues(repoPath: "/repo")
        #expect(result.issues.isEmpty)
        #expect(result.error == "fetch_failed")
        #expect(result.attempts?.first?.reason.rawValue == "future_reason")
        #expect(result.attempts?.first?.transport.rawValue == "future_transport")
        #expect(result.attempts?.first?.transport.known == nil)
    }

    @Test(arguments: ["cli", "rest", "future_transport"])
    func transportValuesRoundTrip(_ raw: String) throws {
        let payload = Data("\"\(raw)\"".utf8)
        let value = try JSONDecoder().decode(Components.Schemas.IssueFetchTransport.self, from: payload)
        #expect(value.rawValue == raw)
        #expect(value.known?.rawValue == (raw == "future_transport" ? nil : raw))
        #expect(try JSONEncoder().encode(value) == payload)
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
            {"epics":[{"parentIssueNumber":412,"parentTitle":"Parent","total":2,"merged":0,
            "status":"idle","source":"native","inFlight":0,"inFlightBy":[],
            "assignedOthers":[],"authoredByOther":null}],"subIssues":[413,414]}
            """.utf8))
        let result = try await makeClient(server).epics(repoPath: "/repo")
        #expect(result.epics.first?.parentIssueNumber == 412)
        #expect(result.epics.first?.parentTitle == "Parent")
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

private actor UploadProgressRecorder {
    var values: [Int] = []
    func record(_ bytes: Int) { values.append(bytes) }
}
