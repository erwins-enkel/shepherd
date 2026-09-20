#if os(macOS)
import Foundation
import Synchronization
import Testing
@testable import ShepherdKit

/// Only this serialized suite uses the stub. The lock also synchronizes access
/// from Foundation's custom-protocol thread; serialization alone cannot do that.
private final class HealthStubProtocol: URLProtocol, @unchecked Sendable {
  static let handler = Mutex<(@Sendable (URLRequest) throws -> (HTTPURLResponse, Data))?>(nil)
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    guard let handler = Self.handler.withLock({ $0 }) else {
      client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse)); return
    }
    do {
      let (response, data) = try handler(request)
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: data)
      client?.urlProtocolDidFinishLoading(self)
    } catch { client?.urlProtocol(self, didFailWithError: error) }
  }
  override func stopLoading() {}
}

@Suite(.serialized, .timeLimit(.minutes(1))) struct LocalHealthCheckTests {
  private func check(
    _ handler: @escaping @Sendable (URLRequest) throws -> (HTTPURLResponse, Data)
  ) async -> Bool {
    HealthStubProtocol.handler.withLock { $0 = handler }
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [HealthStubProtocol.self]
    let session = URLSession(configuration: config)
    defer {
      session.invalidateAndCancel()
      HealthStubProtocol.handler.withLock { $0 = nil }
    }
    // Other suites deliberately sleep in URLProtocol handlers. Foundation runs
    // those on the same custom-protocol thread, even for different sessions.
    // Test response decoding with headroom; production keeps its 1.5 s budget.
    return await LocalHealthCheck(port: 7330, session: session, timeout: 10)()
  }

  private func body(_ text: String, status: Int = 200)
    -> @Sendable (URLRequest) throws -> (HTTPURLResponse, Data) {
    { request in
      (HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!,
       Data(text.utf8))
    }
  }

  @Test func theURLIsLoopbackHealthOnTheGivenPort() {
    #expect(LocalHealthCheck(port: 7330).url.absoluteString == "http://127.0.0.1:7330/api/health")
    #expect(LocalHealthCheck(port: 7331).url.absoluteString == "http://127.0.0.1:7331/api/health")
  }

  @Test func okTrueIsHealthyAndNothingElseIs() async {
    #expect(await check(body(#"{"ok":true,"version":"3.41.0"}"#)) == true)
    #expect(await check(body(#"{"ok":false,"version":"3.41.0"}"#)) == false)
    #expect(await check(body(#"{"ok":true,"version":"3"}"#, status: 503)) == false)
    #expect(await check(body("<html>nginx</html>")) == false)
    #expect(await check({ _ in throw URLError(.cannotConnectToHost) }) == false)
  }
}
#endif
