import Foundation
import Testing
@testable import ShepherdKit
struct ShepherdClientSettingsTests {
    func client(_ server: FakeShepherdServer, session: URLSession? = nil) throws -> ShepherdClient {
        try ShepherdClient(profile: .init(name: "fixture", baseURL: server.baseURL, mode: .local),
            credentials: InMemoryCredentialStore(), urlSession: session ?? server.urlSession())
    }
    @Test func patchSendsOnlyOneSetting() async throws {
        let server = FakeShepherdServer(); defer { server.tearDown() }
        server.on("PATCH", "/api/settings") { request in
            let data = try #require(request.body)
            let body = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            #expect(body.count == 1); #expect(body["reducedPushMode"] as? Bool == true)
            return FakeResponse(body: Data(#"{"reducedPushMode":true}"#.utf8))
        }
        #expect(try await client(server).patchSettings(body: .init(reducedPushMode:true)).reducedPushMode == true)
    }
    @Test func adminUsesCookieWithoutBearerAndAnotherJarCannotSeeIt() async throws {
        let server = FakeShepherdServer(); defer { server.tearDown() }
        server.on("POST", "/api/login") { request in
            #expect(request.headers["Authorization"] == nil)
            return FakeResponse(headers: ["Content-Type":"application/json", "Set-Cookie":"shepherd_session=fixture; Path=/; HttpOnly"], body: Data(#"{"ok":true}"#.utf8))
        }
        server.on("GET", "/api/access-tokens") { request in
            #expect(request.headers["Authorization"] == nil)
            let cookie = request.headers["Cookie"]
            return cookie?.contains("shepherd_session=fixture") == true
                ? FakeResponse(body: Data(#"{"tokens":[]}"#.utf8))
                : FakeResponse(statusCode: 401, body: Data(#"{"error":"unauthorized"}"#.utf8))
        }
        let admin = try client(server)
        try await admin.loginForTokenAdministration(password: "fixture")
        #expect(try await admin.listAccessTokens().tokens.isEmpty)
        let other = try client(server)
        await #expect(throws: ShepherdError.unauthenticated) { _ = try await other.listAccessTokens() }
    }
    @Test func roles502IsNotDecodedAsGenericError() async throws {
        let server = FakeShepherdServer(); defer { server.tearDown() }
        server.on("PUT", "/api/repo-roles") { _ in FakeResponse(statusCode:502,
            body:Data(#"{"roles":{"reviewer":null,"merger":null},"me":null,"pushError":"push rejected"}"#.utf8)) }
        await #expect(throws: ShepherdError.upstreamFailure(code:nil,message:"push rejected")) {
            _ = try await client(server).putRepoRoles(repo:"/fixture", body:.values(reviewer:nil,merger:nil))
        }
    }
}
