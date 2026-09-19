#if os(macOS)
import Foundation
import Testing
@testable import ShepherdKit

/// URLProtocol is a class cluster with no injection point, so the stub needs the
/// escape hatch the global constraints allow exactly here. Suite is .serialized.
final class HealthStubProtocol: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var handler: (@Sendable (URLRequest) throws -> (HTTPURLResponse, Data))?
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    guard let handler = Self.handler else {
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

@Suite(.serialized) struct LocalHealthCheckTests {
  private func check(
    _ handler: @escaping @Sendable (URLRequest) throws -> (HTTPURLResponse, Data)
  ) -> LocalHealthCheck {
    HealthStubProtocol.handler = handler
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [HealthStubProtocol.self]
    return LocalHealthCheck(port: 7330, session: URLSession(configuration: config))
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
    #expect(await check(body(#"{"ok":true,"version":"3.41.0"}"#))() == true)
    #expect(await check(body(#"{"ok":false,"version":"3.41.0"}"#))() == false)
    #expect(await check(body(#"{"ok":true,"version":"3"}"#, status: 503))() == false)
    #expect(await check(body("<html>nginx</html>"))() == false)
    #expect(await check({ _ in throw URLError(.cannotConnectToHost) })() == false)
  }
}
#endif
