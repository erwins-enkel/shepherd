import Foundation
import Testing
import ShepherdKit
@testable import ShepherdAppCore

/// A scripted answer queue: each call takes the next result, then repeats `fallback`.
private final class UpdateScript<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [Result<T, any Error>]
    private let fallback: Result<T, any Error>
    private var count = 0
    init(_ items: [Result<T, any Error>] = [], then fallback: Result<T, any Error>) {
        self.items = items; self.fallback = fallback
    }
    var calls: Int { lock.withLock { count } }
    func next() throws -> T {
        try lock.withLock { () -> Result<T, any Error> in
            count += 1
            return items.isEmpty ? fallback : items.removeFirst()
        }.get()
    }
}

/// Records apply calls; a clock that moves only when read.
private final class UpdateRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var applied: [(Bool, String?)] = []
    private var time: TimeInterval = 0
    let step: TimeInterval
    let applyError: (any Error)?
    init(step: TimeInterval = 0, applyError: (any Error)? = nil) { self.step = step; self.applyError = applyError }
    func apply(_ discard: Bool, _ sig: String?) throws {
        lock.withLock { applied.append((discard, sig)) }
        if let applyError { throw applyError }
    }
    var applications: [(Bool, String?)] { lock.withLock { applied } }
    func now() -> Date { lock.withLock { defer { time += step }; return Date(timeIntervalSince1970: time) } }
}

@MainActor private final class UpdateCounter { var value = 0 }

@MainActor struct ServerUpdateModelTests {
    nonisolated static func decode<T: Decodable>(_ text: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(text.utf8))
    }
    nonisolated static func status(behind: Int, error: String? = nil) throws -> ServerUpdateStatus {
        let suffix = error.map { #","error":"\#($0)""# } ?? ""
        return try decode(#"{"behind":\#(behind),"current":"aaaaaaa","latest":"bbbbbbb","commits":[],"checkedAt":1\#(suffix)}"#)
    }
    nonisolated static func dirty(_ isDirty: Bool, sig: String? = "s1") throws -> ServerUpdateDirty {
        let sigJSON = sig.map { "\"\($0)\"" } ?? "null"
        return try decode(#"{"dirty":\#(isDirty),"dirtyFiles":[" M a.ts"],"dirtyCount":1,"sig":\#(sigJSON)}"#)
    }
    nonisolated static func deploy(_ phase: String, log: String = "", reason: String? = nil) throws -> ServerUpdateDeploy {
        let reasonJSON = reason.map { "\"\($0)\"" } ?? "null"
        return try decode(#"{"phase":"\#(phase)","exitCode":\#(phase == "failed" ? "1" : "null"),"log":\#(String(reflecting: log)),"reason":\#(reasonJSON)}"#)
    }

    private func makeModel(
        status: UpdateScript<ServerUpdateStatus>? = nil,
        dirty: UpdateScript<ServerUpdateDirty>? = nil,
        log: UpdateScript<ServerUpdateDeploy>? = nil,
        recorder: UpdateRecorder = UpdateRecorder(),
        onDone: @escaping @MainActor () -> Void = {}
    ) throws -> ServerUpdateModel {
        let statusScript = try status ?? UpdateScript(then: .success(Self.status(behind: 2)))
        let dirtyScript = try dirty ?? UpdateScript(then: .success(Self.dirty(false)))
        let logScript = try log ?? UpdateScript(then: .success(Self.deploy("done")))
        return ServerUpdateModel(calls: .init(
            status: { try statusScript.next() },
            dirty: { try dirtyScript.next() },
            apply: { try recorder.apply($0, $1) },
            log: { try logScript.next() },
            sleep: { _ in await Task.yield(); try Task.checkCancellation() },
            now: { recorder.now() }),
            onDone: onDone)
    }

    @Test func theOfferFollowsTheServersOwnUpdateStatus() async throws {
        let cases: [(Result<ServerUpdateStatus, any Error>, ServerUpdateOffer)] = [
            (.success(try Self.status(behind: 3)), .updateServer(behind: 3)),
            (.success(try Self.status(behind: 0)), .testFlight),
            (.success(try Self.status(behind: 0, error: "fetch failed")), .none),
            (.failure(ShepherdError.transport("down")), .none),
        ]
        for (answer, offer) in cases {
            let model = try makeModel(status: UpdateScript(then: answer))
            await model.refreshOffer()
            #expect(model.offer == offer)
            model.teardown()
        }
    }

    @Test func openingProbesTheTreeFreshAndPicksTheMode() async throws {
        let cases: [(Result<ServerUpdateDirty, any Error>, ServerUpdateMode)] = [
            (.success(try Self.dirty(false)), .clean),
            (.success(try Self.dirty(true)), .dirty),
            (.success(try Self.dirty(true, sig: nil)), .tooLarge),
            (.failure(ShepherdError.serverFailure(status: 500, message: nil)), .clean),
        ]
        for (answer, mode) in cases {
            let dirty = UpdateScript(then: answer)
            let model = try makeModel(dirty: dirty)
            await model.open()
            #expect(model.presented && model.mode == mode)
            await model.open()
            #expect(dirty.calls == 2, "the tree is volatile: every open probes again")
            model.teardown()
        }
    }

    @Test func aDiscardSendsTheSignatureThatWasShown() async throws {
        let recorder = UpdateRecorder()
        let model = try makeModel(dirty: UpdateScript(then: .success(Self.dirty(true, sig: "shown"))), recorder: recorder)
        await model.open()
        model.arming = true
        await model.confirmDiscard()
        #expect(!model.arming)
        #expect(recorder.applications.map { $0.0 } == [true] && recorder.applications.map { $0.1 } == ["shown"])
        await model.watchTask?.value
        model.teardown()
    }

    @Test func aStaleDiscardReplacesTheListAndAsksAgain() async throws {
        let fresh = try Self.dirty(true, sig: "fresh")
        let model = try makeModel(dirty: UpdateScript(then: .success(Self.dirty(true, sig: "shown"))),
                              recorder: UpdateRecorder(applyError: ServerUpdateStale(dirty: fresh)))
        await model.open()
        await model.confirmDiscard()
        #expect(model.dirty?.sig == "fresh" && model.staleHint && model.mode == .dirty)
        #expect(!model.updating && model.watchTask == nil)
        model.teardown()
    }

    @Test func aRefusalShowsTheServersReason() async throws {
        let model = try makeModel(recorder: UpdateRecorder(applyError: ShepherdError.conflict(code: nil, message: "no update available")))
        await model.open()
        await model.runUpdate()
        #expect(model.error == "no update available" && model.mode == .clean && !model.updating)
        model.teardown()
    }

    @Test func aStartedUpdateFollowsTheLogThroughTheRestartThenReconnects() async throws {
        let reconnects = UpdateCounter()
        let log = try UpdateScript<ServerUpdateDeploy>([
            .success(Self.deploy("running", log: "install\nbuild\n")),
            .failure(ShepherdError.transport("connection refused")),
            .success(Self.deploy("done")),
        ], then: .success(Self.deploy("done")))
        let model = try makeModel(log: log, onDone: { reconnects.value += 1 })
        await model.refreshOffer()
        await model.open()
        await model.runUpdate()
        #expect(model.updating && model.mode == .progress)
        await model.watchTask?.value
        #expect(reconnects.value == 1 && log.calls == 3)
        #expect(!model.updating && !model.presented && model.offer == .none && model.deploy == nil)
        model.teardown()
    }

    @Test func aFailedDeployShowsItsLogOrRoutesADirtyTreeBackThroughTheProbe() async throws {
        let plain = try makeModel(log: UpdateScript(then: .success(Self.deploy("failed", log: "boom"))))
        await plain.open()
        await plain.runUpdate()
        await plain.watchTask?.value
        #expect(plain.mode == .rawLog && plain.deploy?.exitCode == 1 && plain.deploy?.log == "boom")
        plain.teardown()

        let routes: [(ServerUpdateDirty, ServerUpdateMode)] = [(try Self.dirty(true), .dirty), (try Self.dirty(false), .nowClean)]
        for (probe, mode) in routes {
            let dirty = UpdateScript(then: .success(probe))
            let model = try makeModel(dirty: dirty, log: UpdateScript(then: .success(Self.deploy("failed", reason: "stale"))))
            await model.open()
            await model.runUpdate()
            await model.watchTask?.value
            #expect(dirty.calls == 2 && model.staleHint && model.mode == mode)
            model.teardown()
        }
    }

    @Test func aServerThatStaysUnreachableEndsTheWaitAfterThreeMinutes() async throws {
        let reconnects = UpdateCounter()
        let model = try makeModel(log: UpdateScript(then: .failure(ShepherdError.transport("down"))),
                              recorder: UpdateRecorder(step: 61), onDone: { reconnects.value += 1 })
        await model.open()
        await model.runUpdate()
        await model.watchTask?.value
        #expect(model.mode == .rawLog && model.deploy?.log == L.t("updatemodal_unreachable"))
        #expect(reconnects.value == 0 && !model.updating)
        model.teardown()
    }

    @Test func teardownStopsFollowingTheDeploy() async throws {
        let model = try makeModel(log: UpdateScript(then: .success(Self.deploy("running"))))
        await model.open()
        await model.runUpdate()
        let watch = model.watchTask
        model.teardown()
        await watch?.value
        #expect(model.watchTask == nil)
    }

    @Test func theLiveLineIsTheNewestNonEmptyLineCapped() {
        #expect(ServerUpdateModel.lastLogLine("install\n  build  \n\n") == "build")
        #expect(ServerUpdateModel.lastLogLine("\n \n") == nil)
        #expect(ServerUpdateModel.lastLogLine(String(repeating: "x", count: 400))?.count == 160)
    }
}
