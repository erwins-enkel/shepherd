import Foundation
import Testing
@testable import ShepherdKit

/// #2987: the self-update routes as the iOS "update the server" flow uses them.
@Suite(.timeLimit(.minutes(1)))
struct ShepherdClientServerUpdateTests {
    private func client(_ server: FakeShepherdServer) throws -> ShepherdClient {
        try ShepherdClient(profile: .init(name: "fixture", baseURL: server.baseURL, mode: .local),
            credentials: InMemoryCredentialStore(), urlSession: server.urlSession())
    }

    private static let dirtyJSON = #"{"dirty":true,"dirtyFiles":[" M src/a.ts"],"dirtyCount":3,"sig":"sig-2"}"#

    @Test func readsStatusLogAndDirtySnapshot() async throws {
        let server = FakeShepherdServer(); defer { server.tearDown() }
        server.on("GET", "/api/update") { _ in FakeResponse(body: Data(
            #"{"behind":2,"current":"aaaaaaa","latest":"bbbbbbb","commits":[{"sha":"bbbbbbb","subject":"fix: newer"}],"checkedAt":1}"#.utf8)) }
        server.on("GET", "/api/update/log") { _ in FakeResponse(body: Data(
            #"{"phase":"failed","exitCode":1,"log":"needs a clean tree","reason":"dirty"}"#.utf8)) }
        server.on("GET", "/api/update/dirty") { _ in FakeResponse(body: Data(Self.dirtyJSON.utf8)) }
        let client = try client(server)

        let status = try await client.updateStatus()
        #expect(status.behind == 2 && status.current == "aaaaaaa" && status.latest == "bbbbbbb")
        #expect(status.commits.map(\.subject) == ["fix: newer"] && status.error == nil)
        let log = try await client.updateLog()
        #expect(log.phase == "failed" && log.exitCode == 1 && log.reason == "dirty")
        let dirty = try await client.updateDirty()
        #expect(dirty.dirty && dirty.dirtyFiles == [" M src/a.ts"] && dirty.dirtyCount == 3 && dirty.sig == "sig-2")
    }

    @Test func idleLogAndUncheckedStatusDecodeTheirNulls() async throws {
        let server = FakeShepherdServer(); defer { server.tearDown() }
        server.on("GET", "/api/update") { _ in FakeResponse(body: Data(
            #"{"behind":0,"current":null,"latest":null,"commits":[],"checkedAt":1,"error":"fetch failed"}"#.utf8)) }
        server.on("GET", "/api/update/log") { _ in FakeResponse(body: Data(#"{"phase":"idle","exitCode":null,"log":""}"#.utf8)) }
        let client = try client(server)
        let status = try await client.updateStatus()
        #expect(status.current == nil && status.error == "fetch failed")
        let log = try await client.updateLog()
        #expect(log.exitCode == nil && log.reason == nil)
    }

    @Test func aPlainUpdateSendsAnEmptyBodyAndADiscardSendsTheShownSignature() async throws {
        let server = FakeShepherdServer(); defer { server.tearDown() }
        server.on("POST", "/api/update") { _ in FakeResponse(statusCode: 202, body: Data(#"{"ok":true}"#.utf8)) }
        let client = try client(server)
        try await client.applyUpdate()
        try await client.applyUpdate(discard: true, sig: "sig-1")
        let bodies = try server.requests().map { request -> [String: Any] in
            let data = try #require(request.body)
            return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        }
        #expect(bodies.count == 2 && bodies[0].isEmpty)
        #expect(bodies[1]["discard"] as? Bool == true && bodies[1]["sig"] as? String == "sig-1")
    }

    @Test func aStaleDiscardCarriesTheFreshSnapshot() async throws {
        let server = FakeShepherdServer(); defer { server.tearDown() }
        server.on("POST", "/api/update") { _ in
            FakeResponse(statusCode: 409, body: Data(#"{"error":"stale","dirty":\#(Self.dirtyJSON)}"#.utf8))
        }
        do {
            try await client(server).applyUpdate(discard: true, sig: "sig-1")
            Issue.record("expected a stale refusal")
        } catch let stale as ServerUpdateStale {
            #expect(stale.dirty.sig == "sig-2" && stale.dirty.dirtyCount == 3)
        }
    }

    @Test(arguments: [
        (400, #"{"error":"body.sig must be a string"}"#, ShepherdError.badRequest("body.sig must be a string")),
        (401, #"{"error":"unauthorized"}"#, .unauthenticated),
        (403, #"{"error":"insufficient_scope"}"#, .forbidden),
        (409, #"{"error":"no update available"}"#, .conflict(code: nil, message: "no update available")),
        (409, #"{"error":"stale"}"#, .conflict(code: nil, message: "stale")),
        (503, #"{"error":"updates not available"}"#, .upstreamFailure(code: nil, message: "updates not available")),
        (500, #"{"error":"could not start the update"}"#, .serverFailure(status: 500, message: "could not start the update")),
    ])
    func applyMapsEveryRefusal(_ c: (Int, String, ShepherdError)) async throws {
        let server = FakeShepherdServer(); defer { server.tearDown() }
        server.on("POST", "/api/update") { _ in FakeResponse(statusCode: c.0, body: Data(c.1.utf8)) }
        await #expect(throws: c.2) { try await client(server).applyUpdate() }
    }

    @Test func readsMapAuthenticationScopeAndServerFailures() async throws {
        let cases: [(Int, ShepherdError)] = [
            (401, .unauthenticated), (403, .forbidden), (500, .serverFailure(status: 500, message: "boom")),
        ]
        for (status, expected) in cases {
            let server = FakeShepherdServer(); defer { server.tearDown() }
            for path in ["/api/update", "/api/update/log", "/api/update/dirty"] {
                server.stub("GET", path, status: status, json: try Fixtures.errorJSON("boom"))
            }
            let client = try client(server)
            await #expect(throws: expected) { _ = try await client.updateStatus() }
            await #expect(throws: expected) { _ = try await client.updateLog() }
            await #expect(throws: expected) { _ = try await client.updateDirty() }
        }
        let server = FakeShepherdServer(); defer { server.tearDown() }
        server.stub("GET", "/api/update/dirty", status: 503, json: try Fixtures.errorJSON("updates not available"))
        await #expect(throws: ShepherdError.upstreamFailure("updates not available")) {
            _ = try await client(server).updateDirty()
        }
    }
}
