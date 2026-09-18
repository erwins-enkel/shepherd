import Foundation
import Testing
@testable import Shepherd

/// URLProtocol stub. `nonisolated(unsafe)` is unavoidable here: URLProtocol is a
/// class-cluster API with no injection point, and the suite below is .serialized.
final class StubProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

@Suite(.serialized)
struct LocalServerProbeTests {
    private func makeProbe(
        _ handler: @escaping @Sendable (URLRequest) throws -> (HTTPURLResponse, Data)
    ) -> LocalServerProbe {
        StubProtocol.handler = handler
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return LocalServerProbe(session: URLSession(configuration: config))
    }

    private func ok(
        _ body: String, status: Int = 200
    ) -> @Sendable (URLRequest) throws -> (HTTPURLResponse, Data) {
        { request in
            (HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!,
             Data(body.utf8))
        }
    }

    @Test func defaultURLIsLoopback7330Health() {
        #expect(LocalServerProbe.defaultURL.absoluteString == "http://127.0.0.1:7330/api/health")
    }

    @Test func healthyServerReportsItsVersion() async {
        let probe = makeProbe(ok(#"{"ok":true,"version":"3.41.0"}"#))
        #expect(await probe.probe() == .found(version: "3.41.0"))
    }

    @Test func okFalseIsAbsent() async {
        let probe = makeProbe(ok(#"{"ok":false,"version":"3.41.0"}"#))
        #expect(await probe.probe() == .absent)
    }

    @Test func nonTwoHundredIsAbsent() async {
        let probe = makeProbe(ok(#"{"ok":true,"version":"3.41.0"}"#, status: 503))
        #expect(await probe.probe() == .absent)
    }

    @Test func unparsableBodyIsAbsent() async {
        let probe = makeProbe(ok("<html>nginx</html>"))
        #expect(await probe.probe() == .absent)
    }

    @Test func connectionRefusedIsAbsent() async {
        let probe = makeProbe { _ in throw URLError(.cannotConnectToHost) }
        #expect(await probe.probe() == .absent)
    }
}
