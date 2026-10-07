import Foundation
import Synchronization
import ShepherdKit
@testable import ShepherdIOS

/// Per-origin snapshots prevent background reconnection from erasing rendered fixture rows.
final class IOSMultiServerFixtureTransport: URLProtocol, @unchecked Sendable {
    private static let snapshots = Mutex<[String: [Session]]>([:])
    private static let repos = Mutex<[String: String]>([:])
    private static let settings = Mutex<[String: String]>([:])
    private static let diagnostics = Mutex<[String: String]>([:])
    static func set(_ sessions: [Session], for url: URL) { snapshots.withLock { $0[url.host() ?? ""] = sessions } }
    /// Raw `repos` array JSON for one origin; others serve the single `shepherd` repo.
    static func setRepos(_ json: String, for url: URL) { repos.withLock { $0[url.host() ?? ""] = json } }
    static func setSettings(_ json: String, for url: URL) { settings.withLock { $0[url.host() ?? ""] = json } }
    static func setDiagnostics(_ json: String, for url: URL) { diagnostics.withLock { $0[url.host() ?? ""] = json } }
    static let readyDiagnostics = #"{"checks":[{"id":"claude","state":"ok","hintKey":"fixture"},{"id":"codex","state":"ok","hintKey":"fixture"}],"generatedAt":0,"overall":"ok"}"#
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host?.hasSuffix(".multi.fixture.invalid") == true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let url = request.url else { return }
        var status = 200
        let body: Data
        switch url.path {
        case "/api/sessions" where request.httpMethod == "POST":
            status = 201; body = Data(IOSComposeFixtureTransport.sessionJSON.utf8)
            if let session = try? JSONDecoder().decode(Session.self, from: body) {
                Self.snapshots.withLock { $0[url.host() ?? "", default: []].append(session) }
            }
        case "/api/sessions": body = (try? JSONEncoder().encode(Self.snapshots.withLock { $0[url.host() ?? ""] ?? [] })) ?? Data("[]".utf8)
        case "/api/settings":
            let json = Self.settings.withLock { $0[url.host() ?? ""] } ?? #"{"repoRoot":"/fixtures","repoRootDisplay":"/fixtures","firstRunPending":false,"defaultModel":"sonnet","defaultEffort":"medium","defaultAgentProvider":"claude","authMode":"subscription","operatorLanguage":"de"}"#
            body = Data(json.utf8)
        case "/api/health": body = Data(#"{"ok":true,"version":"2.1.0"}"#.utf8)
        case "/api/diagnostics":
            body = Data((Self.diagnostics.withLock { $0[url.host() ?? ""] } ?? Self.readyDiagnostics).utf8)
        case "/api/repos":
            let list = Self.repos.withLock { $0[url.host() ?? ""] } ?? #"[{"name":"shepherd","path":"/fixtures/shepherd","display":"shepherd","realPath":"/fixtures/shepherd","isFork":false,"hidden":false}]"#
            body = Data(#"{"repos":\#(list),"recentWindowDays":14}"#.utf8)
        default: status = 404; body = Data(#"{"error":"not found"}"#.utf8)
        }
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
