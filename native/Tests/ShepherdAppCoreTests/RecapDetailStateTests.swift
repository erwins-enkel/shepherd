import Foundation
import Testing
import ShepherdKit
@testable import ShepherdAppCore

@MainActor
struct RecapDetailStateTests {
    private func recap(_ id: String = "s1", at: Int = 1000) throws -> Recap {
        try JSONDecoder().decode(Recap.self, from: Data("""
        {"sessionId":"\(id)","state":"ready","headline":"Done","body":"Summary","openItems":[],"updatedAt":\(at),"blocks":[]}
        """.utf8))
    }

    @Test func detailSuccessEmptyBlocksAndRetry() async throws {
        let state = RecapDetailState()
        let summary = try recap()
        #expect(state.recap == nil)
        await state.load(sessionID: "s1", summary: summary) { _ in throw ShepherdError.notFound }
        #expect(state.error != nil && !state.isLoading)
        await state.load(sessionID: "s1", summary: summary) { _ in summary }
        #expect(state.current(sessionID: "s1", summary: summary)?.blocks?.isEmpty == true)
        #expect(state.error == nil && !state.isLoading)
        #expect(state.current(sessionID: "s1", summary: try recap(at: 2000)) == nil)
    }

    @Test func lateReadCannotOverwriteAnotherSessionOrClosedPresentation() async throws {
        let state = RecapDetailState()
        let a = try recap("a"), b = try recap("b")
        var pending: CheckedContinuation<Recap, Never>?
        let old = Task { await state.load(sessionID: "a", summary: a) { _ in
            await withCheckedContinuation { pending = $0 }
        } }
        while pending == nil { await Task.yield() }
        await state.load(sessionID: "b", summary: b) { _ in b }
        pending?.resume(returning: a)
        await old.value
        #expect(state.current(sessionID: "b", summary: b)?.sessionId == "b")
        state.close()
        #expect(state.recap == nil && !state.isLoading)
    }

    @Test func staleResponseIsRetryableAndCancellationDoesNotInstallBlocks() async throws {
        let state = RecapDetailState()
        let old = try recap(), fresh = try recap(at: 2000)
        await state.load(sessionID: "s1", summary: fresh) { _ in old }
        #expect(state.error != nil && state.recap == nil)
        var pending: CheckedContinuation<Recap, Never>?
        let task = Task { await state.load(sessionID: "s1", summary: fresh) { _ in
            await withCheckedContinuation { pending = $0 }
        } }
        while pending == nil { await Task.yield() }
        task.cancel()
        pending?.resume(returning: fresh)
        await task.value
        #expect(state.recap == nil && !state.isLoading)
        await state.load(sessionID: "s1", summary: fresh) { _ in fresh }
        let cancelled = Task { await state.load(sessionID: "s1", summary: old) { _ in old } }
        cancelled.cancel()
        await cancelled.value
        #expect(state.current(sessionID: "s1", summary: fresh)?.updatedAt == 2000)
    }

    @Test func newerVersionAndServerLifetimeFencePendingReads() async throws {
        let state = RecapDetailState()
        let old = try recap(), fresh = try recap(at: 2000)
        var pending: CheckedContinuation<Recap, Never>?
        let task = Task { await state.load(sessionID: "s1", summary: old) { _ in
            await withCheckedContinuation { pending = $0 }
        } }
        while pending == nil { await Task.yield() }
        state.close() // server activation changed, even if its session id is identical
        await state.load(sessionID: "s1", summary: fresh) { _ in fresh }
        pending?.resume(returning: old)
        await task.value
        #expect(state.current(sessionID: "s1", summary: fresh)?.updatedAt == 2000)
    }
}
