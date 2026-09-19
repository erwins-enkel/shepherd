import Foundation
import Testing

@testable import ShepherdKit

@Suite("FakeShepherdServer")
struct FakeShepherdServerTests {
  @Test("serves a stubbed route and records the request")
  func servesAndRecords() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub("GET", "/api/health", status: 200, json: try Fixtures.json(Fixtures.health()))

    var request = URLRequest(url: server.baseURL.appending(path: "api/health"))
    request.setValue("Bearer shp_test", forHTTPHeaderField: "Authorization")
    let (data, response) = try await server.urlSession().data(for: request)

    #expect((response as? HTTPURLResponse)?.statusCode == 200)
    let health = try JSONDecoder().decode(Components.Schemas.Health.self, from: data)
    #expect(health.version == "1.47.0")

    let recorded = server.requests()
    #expect(recorded.count == 1)
    #expect(recorded[0].method == "GET")
    #expect(recorded[0].path == "/api/health")
    #expect(recorded[0].headers["Authorization"] == "Bearer shp_test")
  }

  @Test("a Set-Cookie comes back on the next request of the same session only")
  func cookiesAreScopedToOneSession() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.on("POST", "/api/login") { _ in
      FakeResponse(
        statusCode: 200,
        headers: [
          "Content-Type": "application/json",
          "Set-Cookie": "shepherd_session=s1; Path=/; HttpOnly",
        ],
        body: try Fixtures.json(Components.Schemas.Ok(ok: true)))
    }
    server.stub("GET", "/api/health", status: 200, json: try Fixtures.json(Fixtures.health()))

    let session = server.urlSession()
    var login = URLRequest(url: server.baseURL.appending(path: "api/login"))
    login.httpMethod = "POST"
    _ = try await session.data(for: login)
    _ = try await session.data(from: server.baseURL.appending(path: "api/health"))
    #expect(server.requests().last?.headers["Cookie"] == "shepherd_session=s1")

    // A second session has its own jar, so the cookie does not follow it.
    _ = try await server.urlSession().data(from: server.baseURL.appending(path: "api/health"))
    #expect(server.requests().last?.headers["Cookie"] == nil)
  }

  @Test("an unstubbed route fails the request rather than hanging")
  func unstubbedRouteFails() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }

    await #expect(throws: (any Error).self) {
      _ = try await server.urlSession().data(
        from: server.baseURL.appending(path: "api/sessions"))
    }
  }

  @Test("a handler sees the request body")
  func handlerSeesBody() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.on("PUT", "/api/settings") { request in
      let decoded = try JSONDecoder().decode(
        Components.Schemas.RepoRootRequest.self, from: request.body ?? Data())
      #expect(decoded.repoRoot == "/repos")
      return FakeResponse(
        body: try JSONEncoder().encode(
          Components.Schemas.RepoRootResponse(repoRoot: "/repos", repoRootDisplay: "~/repos")))
    }

    var request = URLRequest(url: server.baseURL.appending(path: "api/settings"))
    request.httpMethod = "PUT"
    request.httpBody = try JSONEncoder().encode(
      Components.Schemas.RepoRootRequest(repoRoot: "/repos"))
    let (data, _) = try await server.urlSession().data(for: request)

    let decoded = try JSONDecoder().decode(Components.Schemas.RepoRootResponse.self, from: data)
    #expect(decoded.repoRootDisplay == "~/repos")
  }
}
