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

  /// A session wired to this fake. Hand it to `URLSessionTransport`.
  func urlSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [FakeURLProtocol.self]
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
    let recorded = RecordedRequest(
      method: request.httpMethod?.uppercased() ?? "GET",
      path: url.path(percentEncoded: false),
      query: components?.query,
      headers: request.allHTTPHeaderFields ?? [:],
      body: request.httpBody ?? request.httpBodyStream.map(Self.drain)
    )

    guard let handler = FakeServerRegistry.shared.take(recorded, host: host) else {
      client?.urlProtocol(
        self, didFailWithError: FakeServerError.noRoute("\(recorded.method) \(recorded.path)"))
      return
    }

    do {
      let fake = try handler(recorded)
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

  /// `URLSession` converts a `httpBody` into a stream before the protocol
  /// sees it, so read it back for the handler.
  private static func drain(_ stream: InputStream) -> Data {
    stream.open()
    defer { stream.close() }
    var data = Data()
    let size = 4096
    var buffer = [UInt8](repeating: 0, count: size)
    while stream.hasBytesAvailable {
      let read = stream.read(&buffer, maxLength: size)
      if read <= 0 { break }
      data.append(contentsOf: buffer[0..<read])
    }
    return data
  }
}
