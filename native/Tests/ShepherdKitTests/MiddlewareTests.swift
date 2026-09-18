import Foundation
import HTTPTypes
import OpenAPIRuntime
import Testing

@testable import ShepherdKit

@Suite("Middlewares")
struct MiddlewareTests {
  private let baseURL = URL(string: "http://localhost:7330")!

  @Test("the bearer token from the store is attached")
  func attachesBearer() async throws {
    let store = InMemoryCredentialStore(seed: ["k": StoredCredential(token: "shp_x", tokenId: "t")])
    let middleware = AuthenticationMiddleware(store: store, credentialKey: "k", onUnauthorized: {})

    let seen = Box<HTTPRequest?>(nil)
    _ = try await middleware.intercept(
      HTTPRequest(method: .get, scheme: nil, authority: nil, path: "/api/sessions"),
      body: nil, baseURL: baseURL, operationID: "listSessions"
    ) { request, _, _ in
      seen.set(request)
      return (HTTPResponse(status: .ok), nil)
    }
    #expect(seen.get()?.headerFields[.authorization] == "Bearer shp_x")
  }

  @Test("no credential means no Authorization header")
  func noCredentialNoHeader() async throws {
    let middleware = AuthenticationMiddleware(
      store: InMemoryCredentialStore(), credentialKey: "k", onUnauthorized: {})

    let seen = Box<HTTPRequest?>(nil)
    _ = try await middleware.intercept(
      HTTPRequest(method: .get, scheme: nil, authority: nil, path: "/api/sessions"),
      body: nil, baseURL: baseURL, operationID: "listSessions"
    ) { request, _, _ in
      seen.set(request)
      return (HTTPResponse(status: .ok), nil)
    }
    #expect(seen.get()?.headerFields[.authorization] == nil)
  }

  @Test("a 401 clears the credential and signals needsLogin")
  func unauthorizedClearsAndSignals() async throws {
    let store = InMemoryCredentialStore(seed: ["k": StoredCredential(token: "shp_x", tokenId: "t")])
    let fired = Box(false)
    let middleware = AuthenticationMiddleware(
      store: store, credentialKey: "k", onUnauthorized: { fired.set(true) })

    _ = try await middleware.intercept(
      HTTPRequest(method: .get, scheme: nil, authority: nil, path: "/api/sessions"),
      body: nil, baseURL: baseURL, operationID: "listSessions"
    ) { _, _, _ in (HTTPResponse(status: .unauthorized), nil) }

    #expect(try store.load(for: "k") == nil)
    #expect(fired.get() == true)
  }

  @Test("a 200 leaves the credential alone")
  func okKeepsCredential() async throws {
    let store = InMemoryCredentialStore(seed: ["k": StoredCredential(token: "shp_x", tokenId: "t")])
    let fired = Box(false)
    let middleware = AuthenticationMiddleware(
      store: store, credentialKey: "k", onUnauthorized: { fired.set(true) })

    _ = try await middleware.intercept(
      HTTPRequest(method: .get, scheme: nil, authority: nil, path: "/api/sessions"),
      body: nil, baseURL: baseURL, operationID: "listSessions"
    ) { _, _, _ in (HTTPResponse(status: .ok), nil) }

    #expect(try store.load(for: "k") != nil)
    #expect(fired.get() == false)
  }

  @Test("a bodyless GET is retried three times then gives up")
  func retriesIdempotentGet() async throws {
    let attempts = Box(0)
    let middleware = RetryingMiddleware(maxAttempts: 3, initialBackoff: .milliseconds(1))

    await #expect(throws: (any Error).self) {
      _ = try await middleware.intercept(
        HTTPRequest(method: .get, scheme: nil, authority: nil, path: "/api/sessions"),
        body: nil, baseURL: baseURL, operationID: "listSessions"
      ) { _, _, _ in
        attempts.set(attempts.get() + 1)
        throw URLError(.networkConnectionLost)
      }
    }
    #expect(attempts.get() == 3)
  }

  @Test("a GET that recovers on the second attempt returns the good response")
  func retryRecovers() async throws {
    let attempts = Box(0)
    let middleware = RetryingMiddleware(maxAttempts: 3, initialBackoff: .milliseconds(1))

    let (response, _) = try await middleware.intercept(
      HTTPRequest(method: .get, scheme: nil, authority: nil, path: "/api/sessions"),
      body: nil, baseURL: baseURL, operationID: "listSessions"
    ) { _, _, _ in
      attempts.set(attempts.get() + 1)
      if attempts.get() == 1 { throw URLError(.timedOut) }
      return (HTTPResponse(status: .ok), nil)
    }
    #expect(attempts.get() == 2)
    #expect(response.status == .ok)
  }

  @Test("a 500 on a GET is retried")
  func retriesServerError() async throws {
    let attempts = Box(0)
    let middleware = RetryingMiddleware(maxAttempts: 3, initialBackoff: .milliseconds(1))

    let (response, _) = try await middleware.intercept(
      HTTPRequest(method: .get, scheme: nil, authority: nil, path: "/api/sessions"),
      body: nil, baseURL: baseURL, operationID: "listSessions"
    ) { _, _, _ in
      attempts.set(attempts.get() + 1)
      return (HTTPResponse(status: attempts.get() < 3 ? .internalServerError : .ok), nil)
    }
    #expect(attempts.get() == 3)
    #expect(response.status == .ok)
  }

  @Test("a POST is never retried")
  func doesNotRetryPost() async throws {
    let attempts = Box(0)
    let middleware = RetryingMiddleware(maxAttempts: 3, initialBackoff: .milliseconds(1))

    await #expect(throws: (any Error).self) {
      _ = try await middleware.intercept(
        HTTPRequest(method: .post, scheme: nil, authority: nil, path: "/api/sessions"),
        body: HTTPBody("{}"), baseURL: baseURL, operationID: "createSession"
      ) { _, _, _ in
        attempts.set(attempts.get() + 1)
        throw URLError(.networkConnectionLost)
      }
    }
    #expect(attempts.get() == 1)
  }

  @Test("a 404 is not retried")
  func doesNotRetryNotFound() async throws {
    let attempts = Box(0)
    let middleware = RetryingMiddleware(maxAttempts: 3, initialBackoff: .milliseconds(1))

    let (response, _) = try await middleware.intercept(
      HTTPRequest(method: .get, scheme: nil, authority: nil, path: "/api/sessions/x"),
      body: nil, baseURL: baseURL, operationID: "getSession"
    ) { _, _, _ in
      attempts.set(attempts.get() + 1)
      return (HTTPResponse(status: .notFound), nil)
    }
    #expect(attempts.get() == 1)
    #expect(response.status == .notFound)
  }
}

/// Minimal lock box so test closures can mutate state under Swift 6 strict
/// concurrency without an actor hop. The middleware's `next` closure is
/// `@Sendable` and runs on whatever executor the caller is on.
final class Box<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Value
  init(_ value: Value) { self.value = value }
  func get() -> Value {
    lock.lock()
    defer { lock.unlock() }
    return value
  }
  func set(_ newValue: Value) {
    lock.lock()
    defer { lock.unlock() }
    value = newValue
  }
}
