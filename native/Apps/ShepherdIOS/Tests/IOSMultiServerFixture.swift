import Foundation
import Synchronization
import ShepherdKit
@testable import ShepherdIOS

/// Per-origin snapshots prevent background reconnection from erasing rendered fixture rows.
final class IOSMultiServerFixtureTransport: URLProtocol, @unchecked Sendable {
    private static let hanging = Mutex<Set<String>>([])
    private static let started = Mutex<Set<String>>([])
    static func setHanging(_ value: Bool, for url: URL) {
        hanging.withLock { if value { $0.insert(url.host() ?? "") } else { $0.remove(url.host() ?? "") } }
    }
    static func hasStarted(_ url: URL) -> Bool { started.withLock { $0.contains(url.host() ?? "") } }
    private static let unavailable = Mutex<Set<String>>([])
    static func setUnavailable(_ value: Bool, for url: URL) {
        unavailable.withLock { if value { $0.insert(url.host() ?? "") } else { $0.remove(url.host() ?? "") } }
    }
    private static let snapshots = Mutex<[String: [Session]]>([:])
    private static let repos = Mutex<[String: String]>([:])
    private static let settings = Mutex<[String: String]>([:])
    private static let diagnostics = Mutex<[String: String]>([:])
    /// The machine choice per origin (#2776): the placement preview, and every create body with
    /// its Idempotency-Key.
    private static let placements = Mutex<[String: String]>([:])
    /// `/api/instance` per origin; an origin without one answers 404, like an older server.
    private static let instances = Mutex<[String: String]>([:])
    private static let creates = Mutex<[String: [(body: Data, key: String?)]]>([:])
    static func set(_ sessions: [Session], for url: URL) { snapshots.withLock { $0[url.host() ?? ""] = sessions } }
    /// Raw `repos` array JSON for one origin; others serve the single `shepherd` repo.
    static func setRepos(_ json: String, for url: URL) { repos.withLock { $0[url.host() ?? ""] = json } }
    static func setSettings(_ json: String, for url: URL) { settings.withLock { $0[url.host() ?? ""] = json } }
    static func setDiagnostics(_ json: String, for url: URL) { diagnostics.withLock { $0[url.host() ?? ""] = json } }
    static func setInstance(_ json: String, for url: URL) { instances.withLock { $0[url.host() ?? ""] = json } }
    static func setPlacement(_ json: String, for url: URL) { placements.withLock { $0[url.host() ?? ""] = json } }
    /// The create bodies this origin received, oldest first, with their Idempotency-Key.
    static func created(at url: URL) -> [(body: Data, key: String?)] { creates.withLock { $0[url.host() ?? ""] ?? [] } }
    /// URLSession hands a body to URLProtocol as a stream.
    private static func body(of request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open(); defer { stream.close() }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            guard read > 0 else { break }
            data.append(buffer, count: read)
        }
        return data
    }
    static let readyDiagnostics = #"{"checks":[{"id":"claude","state":"ok","hintKey":"fixture"},{"id":"codex","state":"ok","hintKey":"fixture"}],"generatedAt":0,"overall":"ok"}"#
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host?.hasSuffix(".multi.fixture.invalid") == true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let url = request.url else { return }
        Self.started.withLock { $0.insert(url.host() ?? "") }
        if Self.hanging.withLock({ $0.contains(url.host() ?? "") }) { return }
        if Self.unavailable.withLock({ $0.contains(url.host() ?? "") }) {
            client?.urlProtocol(self, didFailWithError: URLError(.timedOut))
            return
        }
        var status = 200
        let body: Data
        switch url.path {
        case "/api/sessions" where request.httpMethod == "POST":
            let sent = (body: Self.body(of: request), key: request.value(forHTTPHeaderField: "Idempotency-Key"))
            Self.creates.withLock { $0[url.host() ?? "", default: []].append(sent) }
            status = 201; body = Data(IOSComposeFixtureTransport.sessionJSON.utf8)
            if let session = try? JSONDecoder().decode(Session.self, from: body) {
                Self.snapshots.withLock { $0[url.host() ?? "", default: []].append(session) }
            }
        case "/api/sessions": body = (try? JSONEncoder().encode(Self.snapshots.withLock { $0[url.host() ?? ""] ?? [] })) ?? Data("[]".utf8)
        case "/api/settings":
            let json = Self.settings.withLock { $0[url.host() ?? ""] } ?? #"{"repoRoot":"/fixtures","repoRootDisplay":"/fixtures","firstRunPending":false,"defaultModel":"sonnet","defaultEffort":"medium","defaultAgentProvider":"claude","authMode":"subscription","operatorLanguage":"de"}"#
            body = Data(json.utf8)
        case "/api/health": body = Data(#"{"ok":true,"version":"2.1.0"}"#.utf8)
        case "/api/placement" where Self.placements.withLock({ $0[url.host() ?? ""] }) != nil:
            body = Data((Self.placements.withLock { $0[url.host() ?? ""] } ?? "").utf8)
        case "/api/instance" where Self.instances.withLock({ $0[url.host() ?? ""] }) != nil:
            body = Data((Self.instances.withLock { $0[url.host() ?? ""] } ?? "").utf8)
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
