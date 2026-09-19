import Foundation
import Testing
import ShepherdKit
@testable import Shepherd

/// Yields until `condition` holds or the budget runs out — the seam `AppModelTests` uses.
@MainActor
func settleDetail(until condition: () -> Bool, yields: Int = 500) async -> Bool {
    for _ in 0..<yields {
        if condition() { return true }
        await Task.yield()
    }
    return condition()
}

/// Holds an injected read open, so a load can be caught mid-flight and raced.
@MainActor
final class LoadGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var opened = false
    private(set) var isWaiting = false

    func wait() async {
        if opened { return }
        isWaiting = true
        await withCheckedContinuation { self.continuation = $0 }
    }

    func open() {
        opened = true
        isWaiting = false
        continuation?.resume()
        continuation = nil
    }
}

/// A counter the injected reads can bump. A plain `var` would be a mutable capture in a
/// `@MainActor`-isolated escaping closure; a main-actor reference box is the same thing the
/// other suites reach for.
@MainActor
final class CallCounter {
    var calls = 0
}

@MainActor
struct DetailModelTests {
    private func entry(_ n: Int, _ summary: String) -> ActivityEntry {
        ActivityEntry(ts: n, tool: "Edit", summary: summary, status: .init(known: .ok))
    }

    @Test func startsWithNothingCachedForAnySession() {
        #expect(DetailModel(loaders: .stubbed()).activity["s1"] == nil)
    }

    @Test func aSuccessfulLoadLandsAsReady() async {
        var loaders = DetailModel.Loaders.stubbed()
        loaders.activity = { _ in [self.entry(1, "did")] }
        let model = DetailModel(loaders: loaders)
        await model.load(.activity, session: "s1")
        #expect(model.activity["s1"]?.value?.first?.summary == "did")
    }

    @Test func aFailedLoadCarriesLocalisedCopy() async {
        var loaders = DetailModel.Loaders.stubbed()
        loaders.activity = { _ in throw ShepherdError.notFound }
        let model = DetailModel(loaders: loaders)
        await model.load(.activity, session: "s1")
        #expect(model.activity["s1"] == .failed(ShepherdErrorCopy.message(ShepherdError.notFound)))
    }

    @Test func aReadThatOutlivesItsStoreIsDropped() async {
        let gate = LoadGate()
        var loaders = DetailModel.Loaders.stubbed()
        loaders.activity = { _ in
            await gate.wait()
            return [self.entry(1, "late")]
        }
        let model = DetailModel(loaders: loaders)
        let task = Task { await model.load(.activity, session: "s1") }
        #expect(await settleDetail(until: { gate.isWaiting }))
        model.teardown()  // the store this extension belongs to went away
        gate.open()
        await task.value
        #expect(model.activity["s1"] == .loading)
    }

    @Test func anOlderLoadNeverOverwritesANewerOne() async {
        let slow = LoadGate()
        var calls = 0
        var loaders = DetailModel.Loaders.stubbed()
        loaders.activity = { _ in
            calls += 1
            let n = calls
            if n == 1 { await slow.wait() }
            return [self.entry(n, "call \(n)")]
        }
        let model = DetailModel(loaders: loaders)
        let first = Task { await model.load(.activity, session: "s1") }
        #expect(await settleDetail(until: { slow.isWaiting }))
        await model.load(.activity, session: "s1")  // the second call wins
        slow.open()
        await first.value
        #expect(model.activity["s1"]?.value?.first?.summary == "call 2")
    }

    @Test func browsingKeepsTheSourceItWasAskedFor() async {
        var loaders = DetailModel.Loaders.stubbed()
        loaders.worktree = { _, path in
            BrowseListing(path: path ?? "", parent: path == nil ? nil : "", entries: [])
        }
        let model = DetailModel(loaders: loaders)
        await model.browse(session: "s1", source: .worktree, path: "docs")
        #expect(model.files["s1"]?.value?.source == .worktree)
        #expect(model.files["s1"]?.value?.listing.path == "docs")
    }

    @Test func theDiffSurvivesAnAnnotationFailure() async {
        var loaders = DetailModel.Loaders.stubbed()
        loaders.diff = { _ in
            DiffResult(
                base: "main", baseRef: "origin/main", head: "x", fetchFailed: false,
                truncated: false, files: [])
        }
        loaders.annotations = { _ in throw ShepherdError.transport("offline") }
        let model = DetailModel(loaders: loaders)
        await model.load(.diff, session: "s1")
        #expect(model.diff["s1"]?.value?.result.head == "x")
        #expect(model.diff["s1"]?.value?.notes.isEmpty == true)
    }

    /// `.diff` is the one feed with an interval — `.activity` and `.git` refresh from pushes,
    /// so `poll` degrades to a single load for them and there is no loop to stop.
    @Test func pollingStopsWhenItsTaskIsCancelled() async {
        let counter = CallCounter()
        var loaders = DetailModel.Loaders.stubbed()
        loaders.diff = { _ in
            counter.calls += 1
            return DiffResult(
                base: "main", baseRef: "main", head: nil, fetchFailed: false,
                truncated: false, files: [])
        }
        let model = DetailModel(loaders: loaders)
        model.sleep = { _ in try await Task.sleep(for: .milliseconds(1)) }
        let task = Task { await model.poll(.diff, session: "s1") }
        #expect(await settleDetail(until: { counter.calls >= 2 }))
        task.cancel()
        await task.value
        let seen = counter.calls
        _ = await settleDetail(until: { false }, yields: 50)
        #expect(counter.calls == seen)
    }

    @Test func aFeedWithoutAnIntervalPollsExactlyOnce() async {
        let counter = CallCounter()
        var loaders = DetailModel.Loaders.stubbed()
        loaders.activity = { _ in
            counter.calls += 1
            return []
        }
        let model = DetailModel(loaders: loaders)
        await model.poll(.activity, session: "s1")
        #expect(counter.calls == 1)
        #expect(DetailFeed.activity.interval == nil)
        #expect(DetailFeed.diff.interval == .seconds(15))
    }
}
