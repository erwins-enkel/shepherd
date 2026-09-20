import Foundation
import Synchronization
import Testing

@testable import ShepherdKit

@Suite("FakeShepherdServer", .timeLimit(.minutes(1)))
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

  @Test("cancelling a pending delayed response suppresses every callback")
  func cancelsPendingDelayedResponse() {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.on("GET", "/delayed") { _ in FakeResponse(body: Data("ok".utf8), delay: 0.03) }
    let client = CancellationClient()
    let request = URLRequest(url: server.baseURL.appending(path: "delayed"))
    let urlProtocol = FakeURLProtocol(request: request, cachedResponse: nil, client: client)

    urlProtocol.startLoading()
    client.cancel(urlProtocol)
    // Observe past the delivery deadline, including failures and completion.
    Thread.sleep(forTimeInterval: 0.1)
    #expect(client.callbacks.withLock { $0 }.isEmpty)
    #expect(client.lateCallbacks.withLock { $0 }.isEmpty)
  }

  @Test(
    "cancelling inside delayed delivery fences all subsequent callbacks",
    arguments: ["response", "body"])
  func cancelsDuringDelayedDelivery(event: String) {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.on("GET", "/delayed") { _ in FakeResponse(body: Data("ok".utf8), delay: 0.01) }
    let client = CancellationClient(cancelOn: event)
    let request = URLRequest(url: server.baseURL.appending(path: "delayed"))
    let urlProtocol = FakeURLProtocol(request: request, cachedResponse: nil, client: client)

    urlProtocol.startLoading()
    // Cancel from a real callback so overlap is guaranteed without racing a timer.
    #expect(client.cancelled.wait(timeout: .now() + 2) == .success)
    Thread.sleep(forTimeInterval: 0.1)
    let expected = event == "response" ? ["response"] : ["response", "body"]
    #expect(client.callbacks.withLock { $0 } == expected)
    #expect(client.lateCallbacks.withLock { $0 }.isEmpty)
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

  /// Regression: the recorded body must be the exact bytes the client sent,
  /// however `URLSession` chose to hand them to the protocol. A body large
  /// enough to arrive in several stream reads is the case that used to lose
  /// bytes — or all of them — under parallel load.
  @Test("records a large POST body byte-for-byte", arguments: [16, 64 * 1024, 512 * 1024])
  func recordsLargeBodies(byteCount: Int) async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub("POST", "/api/echo", status: 200, json: Data("{}".utf8))

    let filler = String(repeating: "shepherd-", count: max(1, byteCount / 9))
    let sent = try JSONEncoder().encode(["filler": filler])
    var request = URLRequest(url: server.baseURL.appending(path: "api/echo"))
    request.httpMethod = "POST"
    request.httpBody = sent
    _ = try await server.urlSession().data(for: request)

    let recorded = try #require(server.requests().last?.body)
    #expect(recorded == sent)
    #expect(recorded.count == sent.count)
  }

  @Test("records concurrent POST bodies without crossing them over")
  func recordsConcurrentBodies() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.on("POST", "/api/echo") { request in
      FakeResponse(body: request.body ?? Data())
    }
    let session = server.urlSession()

    try await withThrowingTaskGroup(of: Void.self) { group in
      for index in 0..<24 {
        group.addTask {
          let sent = try JSONEncoder().encode(
            ["index": String(index), "filler": String(repeating: "x", count: 8192)])
          var request = URLRequest(url: server.baseURL.appending(path: "api/echo"))
          request.httpMethod = "POST"
          request.httpBody = sent
          let (echoed, _) = try await session.data(for: request)
          #expect(echoed == sent)
        }
      }
      try await group.waitForAll()
    }

    #expect(server.requests().count == 24)
    #expect(server.requests().allSatisfy { ($0.body?.isEmpty == false) })
  }

  /// The root cause of the CI-only flake, reproduced without timing.
  ///
  /// `LateInputStream` is a body stream that has every byte the client sent but
  /// reports `hasBytesAvailable == false` until it has been read from once, and
  /// then hands the payload over in short reads. That is exactly what a loaded
  /// machine's body stream looks like, and a drain gated on `hasBytesAvailable`
  /// returns empty for it.
  @Test("drains a stream that reports no bytes available before the first read")
  func drainsStreamWithLateBytes() throws {
    let payload = Data((0..<(96 * 1024)).map { UInt8($0 % 251) })
    let stream = LateInputStream(payload: payload, chunk: 3000)

    #expect(stream.hasBytesAvailable == false)
    #expect(drainRequestBody(stream) == payload)
  }

  @Test("drains an empty body stream to empty rather than waiting out the timeout")
  func drainsEmptyStream() throws {
    let stream = LateInputStream(payload: Data(), chunk: 4096)
    let started = Date()

    #expect(drainRequestBody(stream) == Data())
    #expect(Date().timeIntervalSince(started) < 1)
  }
}

/// Observes URLProtocol directly: URLSession can discard late callbacks and
/// would hide a violation of the protocol's cancellation contract.
private final class CancellationClient: NSObject, URLProtocolClient, Sendable {
  let callbacks = Mutex<[String]>([])
  let lateCallbacks = Mutex<[String]>([])
  let cancelled = DispatchSemaphore(value: 0)
  private let stopReturned = Mutex(false)
  private let cancelOn: String?

  init(cancelOn: String? = nil) {
    self.cancelOn = cancelOn
  }

  func cancel(_ urlProtocol: URLProtocol) {
    urlProtocol.stopLoading()
    stopReturned.withLock { $0 = true }
    cancelled.signal()
  }

  private func record(_ event: String, _ urlProtocol: URLProtocol) {
    callbacks.withLock { $0.append(event) }
    if stopReturned.withLock({ $0 }) {
      lateCallbacks.withLock { $0.append(event) }
    }
    if event == cancelOn { cancel(urlProtocol) }
  }

  func urlProtocol(
    _ urlProtocol: URLProtocol, didReceive response: URLResponse,
    cacheStoragePolicy policy: URLCache.StoragePolicy
  ) { record("response", urlProtocol) }

  func urlProtocol(_ urlProtocol: URLProtocol, didLoad data: Data) {
    record("body", urlProtocol)
  }

  func urlProtocolDidFinishLoading(_ urlProtocol: URLProtocol) {
    record("finish", urlProtocol)
  }

  func urlProtocol(_ urlProtocol: URLProtocol, didFailWithError error: any Error) {
    record("failure", urlProtocol)
  }

  func urlProtocol(
    _ urlProtocol: URLProtocol, wasRedirectedTo request: URLRequest,
    redirectResponse: URLResponse
  ) { record("redirect", urlProtocol) }

  func urlProtocol(_ urlProtocol: URLProtocol, cachedResponseIsValid cachedResponse: CachedURLResponse) {
    record("cache", urlProtocol)
  }

  func urlProtocol(_ urlProtocol: URLProtocol, didReceive challenge: URLAuthenticationChallenge) {
    record("challenge", urlProtocol)
  }

  func urlProtocol(_ urlProtocol: URLProtocol, didCancel challenge: URLAuthenticationChallenge) {
    record("cancelChallenge", urlProtocol)
  }
}

/// An `InputStream` that holds real bytes but lies about `hasBytesAvailable`
/// until it has been read from, and then delivers the payload in short reads —
/// the behaviour a body stream shows when the producer is still filling it.
private final class LateInputStream: InputStream {
  private let payload: Data
  private let chunk: Int
  private var offset = 0
  private var read = false
  private var status: Stream.Status = .notOpen
  private var streamDelegate: (any StreamDelegate)?

  init(payload: Data, chunk: Int) {
    self.payload = payload
    self.chunk = chunk
    super.init(data: Data())
  }

  override var hasBytesAvailable: Bool { read && offset < payload.count }
  override var streamStatus: Stream.Status { status }
  override var streamError: (any Error)? { nil }

  override var delegate: (any StreamDelegate)? {
    get { streamDelegate }
    set { streamDelegate = newValue }
  }

  override func open() { status = .open }
  override func close() { status = .closed }
  override func schedule(in runLoop: RunLoop, forMode mode: RunLoop.Mode) {}
  override func remove(from runLoop: RunLoop, forMode mode: RunLoop.Mode) {}
  override func property(forKey key: Stream.PropertyKey) -> Any? { nil }
  override func setProperty(_ property: Any?, forKey key: Stream.PropertyKey) -> Bool { false }

  override func getBuffer(
    _ buffer: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>,
    length: UnsafeMutablePointer<Int>
  ) -> Bool { false }

  override func read(_ buffer: UnsafeMutablePointer<UInt8>, maxLength: Int) -> Int {
    read = true
    let count = min(maxLength, chunk, payload.count - offset)
    guard count > 0 else {
      status = .atEnd
      return 0
    }
    payload.copyBytes(to: buffer, from: offset..<(offset + count))
    offset += count
    return count
  }
}

