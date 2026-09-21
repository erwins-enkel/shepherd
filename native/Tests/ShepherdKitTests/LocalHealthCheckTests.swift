#if os(macOS)
import Foundation
import Testing
@testable import ShepherdKit

@Suite(.timeLimit(.minutes(1))) struct LocalHealthCheckTests {
  private func check(
    _ handler: @escaping @Sendable (URLRequest) throws -> (HTTPURLResponse, Data)
  ) async -> Bool {
    await LocalHealthCheck { request in
      #expect(request.url?.absoluteString == "http://127.0.0.1:7330/api/health")
      #expect(request.timeoutInterval == 1.5)
      #expect(request.cachePolicy == .reloadIgnoringLocalAndRemoteCacheData)
      let (response, data) = try handler(request)
      return (data, response)
    }()
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

  @Test func missingOrEmptyVersionCannotCertifyAServer() async {
    #expect(await check(body(#"{"ok":true}"#)) == false)
    #expect(await check(body(#"{"ok":true,"version":""}"#)) == false)
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
