import Foundation
import Testing
import ShepherdKit
@testable import ShepherdAppCore

@MainActor struct RunnerUpdatesModelTests {
    nonisolated static let herdrJSON = #"{"current":"0.8.2","latest":"0.9.3","updateAvailable":true,"notes":null,"checkedAt":1,"phase":"idle","revision":1}"#
    nonisolated static let codexJSON = #"{"current":"0.160.1","latest":"0.162.1","updateAvailable":true,"notes":null,"checkedAt":1}"#
    nonisolated static func decode<T: Decodable>(_ text: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(text.utf8)) }
    nonisolated static func reads(apply: @escaping @Sendable (RunnerUpdateAction) async throws -> Void = { _ in }) -> RunnerUpdateReads {
        .init(herdr: { try decode(herdrJSON) }, codex: { try decode(codexJSON) },
              notes: { .init(current: "0.160.1", latest: "0.162.1", notes: [], complete: true) }, apply: apply)
    }
    @Test func screenshotUpdatesAreVisibleWithoutOpeningSettings() async throws {
        let model = RunnerUpdatesModel(reads: Self.reads())
        await model.loadHerdr(); await model.loadCodex()
        #expect(model.showsHerdr && model.showsCodex)
        #expect(model.herdr?.current == "0.8.2" && model.herdr?.latest == "0.9.3")
        #expect(model.codex?.current == "0.160.1" && model.codex?.latest == "0.162.1")
        #expect(model.canRun(.updateHerdr) && model.canRun(.updateCodex))
        model.teardown()
    }
    @Test func independentFailureDoesNotHideOtherRunner() async {
        var reads = Self.reads(); reads.herdr = { throw ShepherdError.notFound }
        let model = RunnerUpdatesModel(reads: reads)
        await model.loadHerdr(); await model.loadCodex()
        #expect(model.herdrError != nil && model.showsCodex)
        model.teardown()
    }
    @Test func backendFlagsControlActionsWithoutVersionComparisons() async throws {
        let model = RunnerUpdatesModel(reads: Self.reads())
        await model.loadHerdr()
        func status(_ extra: String) { model.receive(.unknown(name: "herdr-update:status", payload: Data((Self.herdrJSON.dropLast() + "," + extra + "}").utf8))) }
        status(#""latestUnsupported":true"#)
        #expect(!model.canRun(.updateHerdr))
        status(#""currentUnsupported":true,"downgradeTarget":"0.8.1""#)
        #expect(model.herdrActions == [.downgradeHerdr])
        status(#""sandboxIdleRegressed":true,"sandboxDowngradeTarget":"0.6.9""#)
        #expect(model.herdrActions == [.updateHerdr, .downgradeSandbox])
        status(#""runtime":{"state":"restart_required","installedVersion":"0.9.3","serverVersion":"0.8.2"}"#)
        let action = try #require(model.herdrActions.first)
        guard case .restartHerdr(let runtime) = action else { Issue.record("expected restart"); return }
        #expect(runtime.installedVersion == "0.9.3" && runtime.serverVersion == "0.8.2")
        status(#""runtime":{"state":"unknown","installedVersion":null,"serverVersion":null}"#)
        #expect(model.herdrActions.isEmpty)
        model.teardown()
    }
    @Test func newerEventWinsOverSuspendedHTTPAndTeardown() async throws {
        let gate = ReadGate()
        var reads = Self.reads(); reads.herdr = { await gate.read() }
        let model = RunnerUpdatesModel(reads: reads)
        let read = Task { await model.loadHerdr() }
        await gate.waitUntilReading()
        model.receive(.unknown(name: "herdr-update:status", payload: Data(Self.herdrJSON.replacingOccurrences(of: "\"revision\":1", with: "\"revision\":4").utf8)))
        await gate.release(try Self.decode(Self.herdrJSON))
        await read.value
        #expect(model.herdr?.revision == 4)
        model.teardown()
        model.receive(.unknown(name: "codex-update:status", payload: Data(Self.codexJSON.utf8)))
        #expect(model.herdr == nil && model.codex == nil && !model.showsCodex)
    }
    @Test func lostCodexDoneIsUncertainNotSuccessOrForeverBusy() async {
        let gate = ActionGate()
        let model = RunnerUpdatesModel(reads: Self.reads(apply: { _ in await gate.run() }))
        await model.loadCodex()
        model.submit(.updateCodex); model.submit(.updateCodex)
        await gate.waitUntilRunning()
        #expect(await gate.count == 1)
        model.disconnected()
        await gate.release()
        await model.loadCodex()
        #expect(!model.codexProgress.busy && model.codexProgress.uncertain)
        #expect(model.codexProgress.succeeded == nil)
        model.receive(.unknown(name: "codex-update:done", payload: Data(#"{"ok":false,"from":"0.160.1","to":"0.160.1","error":"duplicate install","onPathBinary":"/fixture/codex"}"#.utf8)))
        #expect(model.codexProgress.succeeded == false && !model.codexProgress.uncertain)
        #expect(model.codexProgress.onPathBinary == "/fixture/codex")
        model.teardown()
    }
    @Test func modernHerdrRecoversPersistedCompletionAndRejectsOlderRevision() async {
        let model = RunnerUpdatesModel(reads: Self.reads())
        let busy = Self.herdrJSON.replacingOccurrences(of: "idle", with: "verifying").replacingOccurrences(of: "\"revision\":1", with: "\"revision\":2")
        model.receive(.unknown(name: "herdr-update:status", payload: Data(busy.utf8)))
        #expect(model.herdrProgress.busy)
        model.disconnected()
        let done = Self.herdrJSON.replacingOccurrences(of: "\"revision\":1", with: "\"revision\":3").dropLast() + #","result":{"ok":true,"from":"0.8.2","to":"0.9.3"}}"#
        model.receive(.unknown(name: "herdr-update:status", payload: Data(done.utf8)))
        await model.loadHerdr()
        #expect(model.herdr?.revision == 3 && !model.herdrProgress.busy)
        #expect(model.herdrProgress.succeeded == true && !model.herdrProgress.uncertain)
        model.teardown()
    }
    @Test func teardownDiscardsAReadAlreadyInFlight() async throws {
        let gate = ReadGate()
        var reads = Self.reads(); reads.herdr = { await gate.read() }
        let model = RunnerUpdatesModel(reads: reads)
        let read = Task { await model.loadHerdr() }
        await gate.waitUntilReading()
        model.teardown()
        await gate.release(try Self.decode(Self.herdrJSON))
        await read.value
        #expect(model.herdr == nil && !model.showsHerdr && !model.canRun(.updateHerdr))
    }
    @Test func doneBeforeHTTPFailureRemainsAuthoritative() async throws {
        let gate = ActionGate()
        let model = RunnerUpdatesModel(reads: Self.reads(apply: { _ in
            await gate.run(); throw ShepherdError.transport("late failure")
        }))
        await model.loadCodex()
        let action = try #require(model.submit(.updateCodex))
        await gate.waitUntilRunning()
        model.receive(.unknown(name: "codex-update:done", payload: Data(#"{"ok":true,"from":"0.160.1","to":"0.162.1"}"#.utf8)))
        await gate.release()
        await action.value
        // The completion must win after the late HTTP failure has been handled.
        #expect(model.codexProgress.succeeded == true && model.codexProgress.error == nil)
        model.teardown()
    }
    @Test func logsAreBoundedAndMalformedEventsDoNotClearStatus() async {
        let model = RunnerUpdatesModel(reads: Self.reads())
        await model.loadCodex()
        for _ in 0..<220 { model.receive(.unknown(name: "codex-update:log", payload: Data(#"{"line":"fixture"}"#.utf8))) }
        model.receive(.unknown(name: "codex-update:status", payload: Data("{}".utf8)))
        #expect(model.codexProgress.log.count == 200 && model.showsCodex)
        model.teardown()
    }
}

private actor ReadGate {
    private var continuation: CheckedContinuation<HerdrUpdateStatus, Never>?
    func read() async -> HerdrUpdateStatus { await withCheckedContinuation { continuation = $0 } }
    func waitUntilReading() async { while continuation == nil { await Task.yield() } }
    func release(_ value: HerdrUpdateStatus) { continuation?.resume(returning: value); continuation = nil }
}
private actor ActionGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private(set) var count = 0
    func run() async { count += 1; await withCheckedContinuation { continuation = $0 } }
    func waitUntilRunning() async { while continuation == nil { await Task.yield() } }
    func release() { continuation?.resume(); continuation = nil }
}
