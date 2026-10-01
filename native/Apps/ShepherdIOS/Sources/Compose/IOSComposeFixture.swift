#if DEBUG
import SwiftUI
import Foundation
import ShepherdAppCore
import ShepherdKit

/// Isolated test-only presentation. All HTTP is confined to this client's URLProtocol;
/// no live server, microphone, speech service or operator defaults are used.
@MainActor enum IOSComposeFixture {
    static var enabled: Bool {
        ProcessInfo.processInfo.arguments.contains("-ShepherdComposeFixture")
    }
    static func make(app: AppModel) throws -> (SessionStore, ComposeModel, FakeDictationEngine, DictationController) {
        let sessionConfig = URLSessionConfiguration.ephemeral
        sessionConfig.protocolClasses = [IOSComposeFixtureTransport.self]
        let profile = ServerProfile(name: "Fixture", baseURL: URL(string: "http://compose.fixture.invalid")!, mode: .local, credentialKey: "fixture")
        let client = try ShepherdClient(profile: profile, credentials: InMemoryCredentialStore(), urlSession: URLSession(configuration: sessionConfig))
        let store = SessionStore(client: client)
        let model = ComposeModel(client: client, defaults: app.composerDefaults)
        model.repoBranches.allowsStatusProbe = false
        model.repoPath = "/fixtures/shepherd"; model.planGateEnabled = true
        let engine = FakeDictationEngine()
        engine.recording = .init(clips: [], appleText: "Füge einen Dark-Mode-Schalter in den Einstellungen hinzu und aktualisiere die Tests.")
        let voice = DictationController(engine: engine, locale: "de-DE", getText: { model.prompt }, setText: { model.prompt = $0 })
        return (store, model, engine, voice)
    }
}
struct IOSComposeFixtureView: View {
    let app: AppModel
    @State private var fixture: (SessionStore, ComposeModel, FakeDictationEngine, DictationController)?
    var body: some View {
        Group {
            if let id = app.selectedSessionID {
                Text(verbatim: id).accessibilityIdentifier("compose.fixture.created")
            } else if let fixture {
                IOSComposeContent(app: app, store: fixture.0, activation: app.activationGeneration, model: fixture.1, voice: fixture.3, fixtureCurrent: { app.selectedSessionID == nil })
                    .task(id: fixture.3.state) {
                        if fixture.3.capturing { fixture.2.emit(.volatile("Füge einen Dark-Mode-Schalter in den Einstellungen hinzu…")); fixture.2.emit(.level(0.8)) }
                    }
            } else { ProgressView() }
        }.task {
            guard fixture == nil else { return }
            if let value = try? IOSComposeFixture.make(app: app) {
                try? await value.0.bootstrap()
                if ProcessInfo.processInfo.arguments.contains("-ShepherdComposeAttachmentFixture") {
                    value.1.prompt = "Add tests"
                    value.1.attachments.addFiles([.init(name: "fixture.txt", data: Data("Attachment fixture".utf8))])
                }
                fixture = value
            }
        }
    }
}

final class IOSComposeFixtureTransport: URLProtocol, @unchecked Sendable {
    private final class UploadAttempts: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        func next() -> Int {
            lock.lock(); defer { lock.unlock() }
            count += 1; return count
        }
    }
    private static let uploadAttempts = UploadAttempts()
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "compose.fixture.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url?.path ?? ""
        var status = 200
        let json: String
        switch path {
        case "/api/sessions" where request.httpMethod == "POST": json = Self.sessionJSON
        case "/api/sessions": json = "[]"
        case "/api/settings": json = #"{"repoRoot":"/fixtures","repoRootDisplay":"/fixtures","firstRunPending":false,"defaultModel":"sonnet","defaultEffort":"medium","defaultAgentProvider":"claude","authMode":"subscription","operatorLanguage":"de"}"#
        case "/api/repos": json = #"{"repos":[{"name":"shepherd","path":"/fixtures/shepherd","display":"shepherd","realPath":"/fixtures/shepherd","isFork":false,"hidden":false}],"recentWindowDays":14}"#
        case "/api/branches": json = #"{"branches":["main"],"current":"main","default":"main"}"#
        case "/api/branch-status": json = #"{"behind":0,"ahead":0,"diverged":false,"hasUpstream":true,"localExists":true}"#
        case "/api/issues": json = #"{"slug":"owner/shepherd","webUrl":"https://example.invalid","issues":[{"number":412,"title":"Add tests","body":"Test the settings","url":"https://example.invalid/412","labels":[],"createdAt":1700000000000,"assignees":[],"author":"operator"}],"viewer":"operator"}"#
        case "/api/commands":
            let provider = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "provider" }?.value
            json = provider == "codex"
                ? #"{"commands":[{"name":"codex-review","description":"Review with Codex","scope":"global","providers":["codex"],"invocations":{"codex":"$codex-review"}}]}"#
                : #"{"commands":[{"name":"review","description":"Review changes","scope":"global"}]}"#
        case "/api/epics": json = #"{"epics":[],"subIssues":[]}"#
        case "/api/uploads":
            if Self.uploadAttempts.next() == 1 {
                status = 500; json = #"{"error":"fixture upload failure"}"#
            } else {
                json = #"{"path":"/fixtures/uploads/fixture.txt","size":18}"#
            }
        default: json = #"{"error":"not found"}"#; status = 404
        }
        if path == "/api/sessions", request.httpMethod == "POST" { status = 201 }
        guard let url = request.url, let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: ["Content-Type":"application/json"]) else { return }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(json.utf8)); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
    static let sessionJSON = #"{"id":"compose-created","desig":"TASK-01","name":"voice-task","prompt":"Add tests","repoPath":"/fixtures/shepherd","baseBranch":"main","branch":null,"worktreePath":"/fixtures/worktree","isolated":false,"herdrSession":"h1","herdrAgentId":"a1","claudeSessionId":"c1","model":null,"effort":null,"readyToMerge":false,"mergingSince":null,"autopilotEnabled":null,"autopilotPaused":false,"autopilotComplete":false,"planGateEnabled":null,"autoMergeEnabled":null,"auto":false,"issueNumber":null,"sandboxApplied":null,"status":"running","lastState":"working","createdAt":1700000000,"updatedAt":1700000001,"archivedAt":null,"archiveReason":null,"haltedAt":null,"manualSteps":[],"experimentRole":null}"#
}
#endif
