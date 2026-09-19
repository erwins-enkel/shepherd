import Foundation

@testable import ShepherdKit

struct FakeResponse: Sendable {
  var statusCode: Int
  var headers: [String: String]
  var body: Data

  init(
    statusCode: Int = 200,
    headers: [String: String] = ["Content-Type": "application/json"],
    body: Data = Data()
  ) {
    self.statusCode = statusCode
    self.headers = headers
    self.body = body
  }
}

struct RecordedRequest: Sendable {
  let method: String
  let path: String
  let query: String?
  let headers: [String: String]
  let body: Data?
}

enum FakeServerError: Error, Equatable {
  case noRoute(String)
}

/// An in-process Shepherd for the HTTP half of the kit's tests.
///
/// `URLProtocol` is registered on one `URLSessionConfiguration.ephemeral`, so
/// the fake is scoped to the session handed to `URLSessionTransport` and
/// nothing leaks between suites. Each instance gets a unique host, so
/// parallel suites route to their own registry entry.
final class FakeShepherdServer: Sendable {
  private let host: String
  private let registryKey: String

  let baseURL: URL

  init() {
    let id = UUID().uuidString.lowercased()
    host = "\(id).fake.shepherd.invalid"
    registryKey = host
    baseURL = URL(string: "http://\(host)")!
    FakeServerRegistry.shared.register(registryKey)
  }

  /// Installs a handler for `method path`. The handler runs on the URL
  /// loading system's thread; throw to fail the request.
  func on(
    _ method: String,
    _ path: String,
    _ handler: @escaping @Sendable (RecordedRequest) throws -> FakeResponse
  ) {
    FakeServerRegistry.shared.setHandler(
      registryKey, route: "\(method.uppercased()) \(path)", handler: handler)
  }

  /// Convenience for the common "answer this status with this JSON" case.
  func stub(_ method: String, _ path: String, status: Int, json: Data) {
    on(method, path) { _ in FakeResponse(statusCode: status, body: json) }
  }

  /// Every request the fake has served, oldest first.
  func requests() -> [RecordedRequest] {
    FakeServerRegistry.shared.requests(registryKey)
  }

  /// Header that tells the fake which `URLSession` a request came from, so
  /// it can keep one cookie jar per session (see `urlSession()`).
  static let sessionHeader = "X-Fake-Session"

  /// A session wired to this fake. Hand it to `URLSessionTransport`.
  ///
  /// Each call is a distinct session with a distinct cookie jar inside the
  /// fake: two sessions never see each other's cookies, exactly as two real
  /// `URLSession`s with separate storage would not.
  func urlSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [FakeURLProtocol.self]
    configuration.httpAdditionalHeaders = [Self.sessionHeader: UUID().uuidString]
    return URLSession(configuration: configuration)
  }

  func tearDown() {
    FakeServerRegistry.shared.unregister(registryKey)
  }
}

/// Lock-guarded route/recording table. `URLProtocol.startLoading()` is
/// synchronous and runs on `com.apple.CFNetwork.CustomProtocols`, so this
/// cannot be an actor.
private final class FakeServerRegistry: @unchecked Sendable {
  static let shared = FakeServerRegistry()

  private struct Entry {
    var handlers: [String: @Sendable (RecordedRequest) throws -> FakeResponse] = [:]
    var recorded: [RecordedRequest] = []
    /// One cookie jar per client session id, name -> value.
    var cookies: [String: [String: String]] = [:]
  }

  private let lock = NSLock()
  private var entries: [String: Entry] = [:]

  func register(_ key: String) {
    lock.lock()
    defer { lock.unlock() }
    entries[key] = Entry()
  }

  func unregister(_ key: String) {
    lock.lock()
    defer { lock.unlock() }
    entries[key] = nil
  }

  func setHandler(
    _ key: String, route: String,
    handler: @escaping @Sendable (RecordedRequest) throws -> FakeResponse
  ) {
    lock.lock()
    defer { lock.unlock() }
    entries[key]?.handlers[route] = handler
  }

  func requests(_ key: String) -> [RecordedRequest] {
    lock.lock()
    defer { lock.unlock() }
    return entries[key]?.recorded ?? []
  }

  /// The `Cookie` header this session would send, or `nil` when its jar is
  /// empty. Cookie names are sorted so the header is deterministic.
  func cookieHeader(host: String, session: String) -> String? {
    lock.lock()
    defer { lock.unlock() }
    guard let jar = entries[host]?.cookies[session], !jar.isEmpty else { return nil }
    return jar.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: "; ")
  }

  /// Applies one `Set-Cookie` value to a session's jar. `Max-Age=0` clears
  /// the cookie, which is how the server's logout expires the session.
  func absorb(setCookie: String, host: String, session: String) {
    let parts = setCookie.split(separator: ";").map {
      $0.trimmingCharacters(in: .whitespaces)
    }
    guard let pair = parts.first, let equals = pair.firstIndex(of: "=") else { return }
    let name = String(pair[pair.startIndex..<equals])
    let value = String(pair[pair.index(after: equals)...])
    let expired = parts.dropFirst().contains {
      $0.lowercased().replacingOccurrences(of: " ", with: "") == "max-age=0"
    }
    lock.lock()
    defer { lock.unlock() }
    entries[host]?.cookies[session, default: [:]][name] = expired ? nil : value
  }

  func knows(host: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return entries[host] != nil
  }

  /// Records the request and returns its handler, without calling out while
  /// the lock is held.
  func take(_ request: RecordedRequest, host: String)
    -> (@Sendable (RecordedRequest) throws -> FakeResponse)?
  {
    lock.lock()
    entries[host]?.recorded.append(request)
    let handler = entries[host]?.handlers["\(request.method) \(request.path)"]
    lock.unlock()
    return handler
  }
}

/// The `URLProtocol` that serves `FakeShepherdServer`.
private final class FakeURLProtocol: URLProtocol {
  override class func canInit(with request: URLRequest) -> Bool {
    // On current macOS the URL loading system DOES route a
    // URLSessionWebSocketTask upgrade through URLProtocol, and a stub cannot
    // emit 101 Switching Protocols — it would break the socket. Let upgrades
    // pass through untouched. (Harmless on OS versions that never ask.)
    if request.value(forHTTPHeaderField: "Upgrade")?.lowercased() == "websocket" { return false }
    guard let host = request.url?.host() else { return false }
    return FakeServerRegistry.shared.knows(host: host)
  }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let url = request.url, let host = url.host() else {
      client?.urlProtocol(self, didFailWithError: FakeServerError.noRoute("<no host>"))
      return
    }
    let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
    // The URL loading system does NOT run its cookie machinery for a custom
    // `URLProtocol`: nothing stores a `Set-Cookie` and nothing replays it on
    // the next request. The fake therefore keeps the jar itself, per client
    // session, so a cookie-authenticated exchange (login then mint) is
    // testable — and so a client that switched sessions mid-exchange would
    // arrive here without its cookie, just as it would against the server.
    let session = request.value(forHTTPHeaderField: FakeShepherdServer.sessionHeader)
    var headers = request.allHTTPHeaderFields ?? [:]
    if headers["Cookie"] == nil, let session,
      let cookies = FakeServerRegistry.shared.cookieHeader(host: host, session: session)
    {
      headers["Cookie"] = cookies
    }
    let recorded = RecordedRequest(
      method: request.httpMethod?.uppercased() ?? "GET",
      path: url.path(percentEncoded: false),
      query: components?.query,
      headers: headers,
      body: request.httpBody ?? request.httpBodyStream.map { drainRequestBody($0) }
    )

    guard let handler = FakeServerRegistry.shared.take(recorded, host: host) else {
      client?.urlProtocol(
        self, didFailWithError: FakeServerError.noRoute("\(recorded.method) \(recorded.path)"))
      return
    }

    do {
      let fake = try handler(recorded)
      if let setCookie = fake.headers["Set-Cookie"], let session {
        FakeServerRegistry.shared.absorb(setCookie: setCookie, host: host, session: session)
      }
      let response = HTTPURLResponse(
        url: url, statusCode: fake.statusCode, httpVersion: "HTTP/1.1",
        headerFields: fake.headers)!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: fake.body)
      client?.urlProtocolDidFinishLoading(self)
    } catch {
      client?.urlProtocol(self, didFailWithError: error)
    }
  }

  override func stopLoading() {}
}

/// Reads an HTTP request body stream to its end and returns every byte.
///
/// `URLSession` turns a `URLRequest.httpBody` into a stream before a custom
/// `URLProtocol` ever sees the request, so this is the only place the fake can
/// recover what the client actually sent. Two details make the obvious loop
/// lose bytes, and both showed up only under CI's parallel load:
///
/// * **`hasBytesAvailable` is a hint, not a state.** It is `false` whenever the
///   producer has not put anything in the buffer *yet*, which on a loaded
///   machine includes the moment right after `open()`. A loop gated on it stops
///   before the first byte arrives and records an empty body — the "Unexpected
///   end of file" the write and login suites were seeing. The end of a stream
///   is `read(_:maxLength:)` returning `0`, and nothing else, so that is what
///   this loop watches.
/// * **A `0` from `read` is only EOF once the stream says so.** While the
///   producer is still filling the buffer, a read can come back empty without
///   the stream being finished, so `0` ends the loop only at `.atEnd`.
///   Otherwise the reader yields the CPU and retries until `timeout`, which
///   bounds a genuinely wedged stream to a failing test rather than a hung job.
///
/// The wait is a short sleep rather than a nested `RunLoop.run`: this runs on
/// CFNetwork's `com.apple.CFNetwork.CustomProtocols` thread inside
/// `startLoading()`, and spinning that thread's run loop would re-enter the
/// URL loading system mid-request. The producer writes from another thread and
/// needs no scheduling from this one.
func drainRequestBody(_ stream: InputStream, timeout: TimeInterval = 2) -> Data {
  if stream.streamStatus == .notOpen { stream.open() }
  defer { stream.close() }

  var data = Data()
  var buffer = [UInt8](repeating: 0, count: 64 * 1024)
  let deadline = Date().addingTimeInterval(timeout)

  while true {
    let read = stream.read(&buffer, maxLength: buffer.count)
    if read > 0 {
      data.append(contentsOf: buffer[0..<read])
      continue
    }
    // A negative result is a stream error: keep whatever did arrive and let
    // the assertion on the recorded body report the shortfall.
    if read < 0 { break }
    if stream.streamStatus == .atEnd { break }
    if Date() >= deadline { break }
    Thread.sleep(forTimeInterval: 0.001)
  }
  return data
}
