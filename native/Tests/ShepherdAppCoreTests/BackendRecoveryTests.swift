import Foundation
import Testing
import ShepherdKit
@testable import ShepherdAppCore

@MainActor struct BackendRecoveryTests {
    static func snapshot(_ hint: String) throws -> DiagnosticsSnapshot {
        try JSONDecoder().decode(DiagnosticsSnapshot.self, from: Data("""
        {"checks":[{"id":"herdr","state":"error","hintKey":"\(hint)"}],"generatedAt":1,"overall":"error"}
        """.utf8))
    }
    @Test func localActionsRequireMatchingSavedLocalEndpoint() {
        let endpoint = URL(string: "http://127.0.0.1:7330")!
        var profile = ServerProfile(name: "Local", baseURL: endpoint, mode: .local)
        #expect(BackendRecovery.canManageLocal(profile: profile, endpoint: endpoint))
        profile.baseURL = URL(string: "http://127.0.0.1:7331")!
        #expect(!BackendRecovery.canManageLocal(profile: profile, endpoint: endpoint))
        profile.baseURL = endpoint; profile.mode = .remote
        #expect(!BackendRecovery.canManageLocal(profile: profile, endpoint: endpoint))
    }
    @Test func explicitSessionClosuresWinOverNetworkGuesses() {
        #expect(BackendRecovery.classify(serverReachable: false, diagnostics: nil, closure: .gone) == .sessionGone)
        #expect(BackendRecovery.classify(serverReachable: false, diagnostics: nil, closure: .superseded) == .sessionSuperseded)
        #expect(BackendRecovery.classify(serverReachable: false, diagnostics: nil, closure: .unreachable) == .serverUnavailable)
        #expect(BackendRecovery.classify(serverReachable: true, diagnostics: nil, closure: .unreachable) == .undetermined)
    }
    @Test func onlyExplicitOfflineAndMissingHintsMeanRunnerUnavailable() throws {
        for hint in ["diagnostics_hint_herdr_offline", "diagnostics_hint_herdr_missing"] {
            #expect(BackendRecovery.classify(serverReachable: true, diagnostics: try Self.snapshot(hint), closure: nil) == .runnerUnavailable)
        }
        for hint in ["diagnostics_hint_herdr_restart", "diagnostics_hint_herdr_unknown", "diagnostics_hint_herdr_outdated", "future_hint"] {
            #expect(BackendRecovery.classify(serverReachable: true, diagnostics: try Self.snapshot(hint), closure: nil) == .undetermined)
        }
    }
    @Test func eventReplacesSnapshotWithoutSettingsReadsAndInvalidatesOlderRefresh() async throws {
        let gate = RecoveryGate()
        let old = try Self.snapshot("diagnostics_hint_herdr_offline")
        let fresh = try Self.snapshot("diagnostics_hint_herdr_ok")
        let model = BackendRecoveryModel(reads: .init(health: { true }, diagnostics: { await gate.wait(); return old }))
        let task = Task { await model.refresh() }
        await gate.started()
        model.receive(.unknown(name: "diagnostics:status", payload: try JSONEncoder().encode(fresh)))
        await gate.open()
        await task.value
        #expect(model.diagnostics?.checks.first?.hintKey == "diagnostics_hint_herdr_ok")
        model.teardown()
        #expect(model.diagnostics == nil)
        #expect(model.serverReachable == nil)
    }
    @Test func healthSurvivesDiagnosticsAuthenticationFailure() async {
        let model = BackendRecoveryModel(reads: .init(health: { true }, diagnostics: { throw ShepherdError.unauthenticated }))
        await model.refresh()
        #expect(model.serverReachable == true)
        #expect(model.diagnosis(for: .unreachable) == .undetermined)
    }
    @Test func loadingIsNotFailureAndSuccessfulRecheckClearsReadError() async throws {
        let gate = RecoveryGate()
        let reads = DiagnosticReadSequence()
        let model = BackendRecoveryModel(reads: .init(health: { true }, diagnostics: {
            await gate.wait()
            return try await reads.read()
        }))
        defer { model.teardown() }
        #expect(model.diagnosticsError == nil)
        for attempt in 0..<3 {
            let task = Task { await model.refresh() }
            await gate.started()
            #expect(model.diagnosticsLoading)
            #expect(model.diagnosticsError == nil)
            await gate.open()
            await task.value
            #expect(!model.diagnosticsLoading)
            if attempt < 2 {
                #expect(model.diagnosticsError != nil)
                #expect(model.diagnostics == nil)
            } else {
                #expect(model.diagnosticsError == nil)
                #expect(model.diagnostics?.checks.first?.hintKey == "diagnostics_hint_herdr_ok")
            }
        }
    }

    @Test func diagnosticEventAndTeardownDiscardOlderReadFailures() async throws {
        let gate = RecoveryGate()
        let model = BackendRecoveryModel(reads: .init(health: { true }, diagnostics: {
            await gate.wait(); throw ShepherdError.unauthenticated
        }))
        let task = Task { await model.refresh() }
        await gate.started()
        model.replaceDiagnostics(try Self.snapshot("diagnostics_hint_herdr_ok"))
        #expect(!model.diagnosticsLoading)
        await gate.open(); await task.value
        #expect(model.diagnosticsError == nil)
        #expect(model.diagnostics != nil)
        let next = Task { await model.refresh() }
        await gate.started()
        model.teardown()
        await gate.open(); await next.value
        #expect(model.diagnostics == nil)
        #expect(model.diagnosticsError == nil)
        #expect(!model.diagnosticsLoading)
    }

    @Test func validationAuthenticationAndCancellationDoNotOfferBackendRecovery() {
        for error in [ShepherdError.unauthenticated, .forbidden, .badRequest("bad"), .cancelled] {
            #expect(!BackendRecovery.isCompatibleCreateFailure(error))
        }
        #expect(BackendRecovery.isCompatibleCreateFailure(ShepherdError.transport("offline")))
        #expect(BackendRecovery.isCompatibleCreateFailure(ShepherdError.upstreamFailure(code: "herdr_offline", message: "offline")))
    }
}
private actor RecoveryGate {
    private var continuation: CheckedContinuation<Void, Never>?
    func wait() async { await withCheckedContinuation { continuation = $0 } }
    func started() async { while continuation == nil { await Task.yield() } }
    func open() { continuation?.resume(); continuation = nil }
}

private actor DiagnosticReadSequence {
    private var count = 0
    func read() throws -> DiagnosticsSnapshot {
        count += 1
        if count < 3 { throw ShepherdError.notFound }
        return try JSONDecoder().decode(DiagnosticsSnapshot.self, from: Data(#"{"checks":[{"id":"herdr","state":"ok","hintKey":"diagnostics_hint_herdr_ok"}],"generatedAt":2,"overall":"ok"}"#.utf8))
    }
}
