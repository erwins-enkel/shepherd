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

/// A main-actor box so an injected read can reach the model it belongs to — the model cannot be
/// captured by the closures its own initialiser takes.
@MainActor
final class ModelBox {
    var model: DetailModel?
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

    // MARK: - H1: a refresh keeps the last good value visible

    @Test func aRefreshKeepsTheOldValueVisibleWhileItRuns() async {
        let gate = LoadGate()
        var calls = 0
        var loaders = DetailModel.Loaders.stubbed()
        loaders.activity = { _ in
            calls += 1
            let n = calls
            if n == 2 { await gate.wait() }
            return [self.entry(n, "call \(n)")]
        }
        let model = DetailModel(loaders: loaders)
        await model.load(.activity, session: "s1")
        #expect(model.activity["s1"]?.value?.first?.summary == "call 1")
        #expect(model.isRefreshing(.activity, session: "s1") == false)

        let refresh = Task { await model.load(.activity, session: "s1") }
        #expect(await settleDetail(until: { gate.isWaiting }))
        // Still the old value — a refresh never blanks to `.loading`.
        #expect(model.activity["s1"]?.value?.first?.summary == "call 1")
        #expect(model.isRefreshing(.activity, session: "s1"))

        gate.open()
        await refresh.value
        #expect(model.activity["s1"]?.value?.first?.summary == "call 2")
        #expect(model.isRefreshing(.activity, session: "s1") == false)
    }

    @Test func aFailedRefreshKeepsTheLastGoodValueRatherThanShowingAnError() async {
        var calls = 0
        var loaders = DetailModel.Loaders.stubbed()
        loaders.activity = { _ in
            calls += 1
            if calls == 1 { return [self.entry(1, "good")] }
            throw ShepherdError.transport("offline")
        }
        let model = DetailModel(loaders: loaders)
        await model.load(.activity, session: "s1")
        #expect(model.activity["s1"]?.value?.first?.summary == "good")

        await model.load(.activity, session: "s1")  // the refresh that fails
        #expect(model.activity["s1"]?.value?.first?.summary == "good")
        #expect(model.activity["s1"]?.failure == nil)
        #expect(model.isRefreshing(.activity, session: "s1") == false)
    }

    @Test func aFailedFirstLoadStillShowsTheError() async {
        var loaders = DetailModel.Loaders.stubbed()
        loaders.activity = { _ in throw ShepherdError.transport("offline") }
        let model = DetailModel(loaders: loaders)
        await model.load(.activity, session: "s1")
        #expect(model.activity["s1"]?.failure != nil)
    }

    // MARK: - H2: a cancelled read writes nothing to the cache

    @Test func aCancelledFirstLoadNeverBecomesAFailure() async {
        var loaders = DetailModel.Loaders.stubbed()
        loaders.activity = { _ in throw CancellationError() }
        let model = DetailModel(loaders: loaders)
        await model.load(.activity, session: "s1")
        // The synchronous `.loading` set before the read still stands — cancelling the read
        // itself must not turn it into `.failed("server unreachable")`.
        #expect(model.activity["s1"] == .loading)
        #expect(model.activity["s1"]?.failure == nil)
    }

    @Test func aCancelledRefreshKeepsTheLastGoodValue() async {
        var calls = 0
        var loaders = DetailModel.Loaders.stubbed()
        loaders.activity = { _ in
            calls += 1
            if calls == 1 { return [self.entry(1, "good")] }
            throw ShepherdError.cancelled
        }
        let model = DetailModel(loaders: loaders)
        await model.load(.activity, session: "s1")
        await model.load(.activity, session: "s1")
        #expect(model.activity["s1"]?.value?.first?.summary == "good")
        #expect(model.isRefreshing(.activity, session: "s1") == false)
    }

    // MARK: - Diff annotations only re-read when the diff itself moved

    @Test func annotationsAreNotRefetchedWhenTheDiffHeadIsUnchanged() async {
        var diffCalls = 0
        var annotationCalls = 0
        var loaders = DetailModel.Loaders.stubbed()
        loaders.annotations = { _ in
            annotationCalls += 1
            return []
        }
        loaders.diff = { _ in
            diffCalls += 1
            let head = diffCalls <= 2 ? "abc" : "def"
            return DiffResult(
                base: "main", baseRef: "main", head: head, fetchFailed: false, truncated: false,
                files: [])
        }
        let model = DetailModel(loaders: loaders)

        await model.load(.diff, session: "s1")  // first load: always reads annotations
        #expect(annotationCalls == 1)
        await model.load(.diff, session: "s1")  // same head: skip
        #expect(annotationCalls == 1)
        await model.load(.diff, session: "s1")  // head moved: read again
        #expect(annotationCalls == 2)
    }

    // MARK: - H3: a push for a session nobody opened is dropped

    @Test func pushLoadsAreSkippedForASessionWithNoCacheEntry() async {
        var calls = 0
        var loaders = DetailModel.Loaders.stubbed()
        loaders.activity = { _ in
            calls += 1
            return []
        }
        let model = DetailModel(loaders: loaders)
        model.schedulePushLoad(.activity, session: "never-opened")
        _ = await settleDetail(until: { false }, yields: 50)
        #expect(calls == 0)
        #expect(model.activity["never-opened"] == nil)
    }

    @Test func pushLoadReloadsASessionAlreadyOpen() async {
        var calls = 0
        var loaders = DetailModel.Loaders.stubbed()
        loaders.activity = { _ in
            calls += 1
            return [self.entry(calls, "push \(calls)")]
        }
        let model = DetailModel(loaders: loaders)
        await model.load(.activity, session: "s1")
        #expect(calls == 1)

        model.schedulePushLoad(.activity, session: "s1")
        #expect(await settleDetail(until: { calls == 2 }))
        #expect(await settleDetail(until: { model.activity["s1"]?.value?.first?.summary == "push 2" }))
    }

    @Test func aBurstOfPushesForTheSameKeyCoalescesIntoOneFollowUpRead() async {
        let gate = LoadGate()
        var calls = 0
        var loaders = DetailModel.Loaders.stubbed()
        loaders.activity = { _ in
            calls += 1
            let n = calls
            if n == 2 { await gate.wait() }
            return [self.entry(n, "call \(n)")]
        }
        let model = DetailModel(loaders: loaders)
        await model.load(.activity, session: "s1")  // seeds the cache entry the push requires
        #expect(calls == 1)

        model.schedulePushLoad(.activity, session: "s1")  // starts call 2, then gates
        #expect(await settleDetail(until: { gate.isWaiting }))
        model.schedulePushLoad(.activity, session: "s1")  // coalesced: no new read yet
        model.schedulePushLoad(.activity, session: "s1")  // still coalesced
        #expect(calls == 2)

        gate.open()
        #expect(await settleDetail(until: { calls == 3 }))  // exactly one follow-up read
        _ = await settleDetail(until: { false }, yields: 50)
        #expect(calls == 3)
    }

    // MARK: - Overlapping refreshes each own their own in-flight mark

    /// A poll tick and a manual Refresh overlap routinely. The one that finishes first must not
    /// clear the "refreshing" mark out from under the one still running, or the Refresh button
    /// re-enables — and the "updating" hint disappears — while a read is still in flight.
    @Test func anOverlappingRefreshStaysMarkedUntilTheSlowerOneFinishes() async {
        let slow = LoadGate()
        let fast = LoadGate()
        var calls = 0
        var loaders = DetailModel.Loaders.stubbed()
        loaders.activity = { _ in
            calls += 1
            let n = calls
            if n == 2 { await slow.wait() }
            if n == 3 { await fast.wait() }
            return [self.entry(n, "call \(n)")]
        }
        let model = DetailModel(loaders: loaders)
        await model.load(.activity, session: "s1")  // call 1 seeds the ready value

        let slower = Task { await model.load(.activity, session: "s1") }  // call 2
        #expect(await settleDetail(until: { slow.isWaiting }))
        let faster = Task { await model.load(.activity, session: "s1") }  // call 3
        #expect(await settleDetail(until: { fast.isWaiting }))
        #expect(model.isRefreshing(.activity, session: "s1"))

        fast.open()
        await faster.value
        // Call 2 is still in flight: the tab is still refreshing.
        #expect(model.isRefreshing(.activity, session: "s1"))

        slow.open()
        await slower.value
        #expect(model.isRefreshing(.activity, session: "s1") == false)
    }

    /// A session that streams frames for hours queues follow-up after follow-up. The follow-up
    /// runner must iterate, so the call chain stays flat however many pushes queue up behind it.
    @Test func aLongRunOfQueuedPushesTerminatesWithOneReadEach() async {
        let box = ModelBox()
        var calls = 0
        var loaders = DetailModel.Loaders.stubbed()
        loaders.activity = { _ in
            calls += 1
            // Queue the next push from inside the running read, 200 times over.
            if calls < 201 { box.model?.schedulePushLoad(.activity, session: "s1") }
            return [self.entry(calls, "call \(calls)")]
        }
        let model = DetailModel(loaders: loaders)
        box.model = model

        await model.load(.activity, session: "s1")  // call 1, and queues the first push
        #expect(await settleDetail(until: { calls == 201 }, yields: 5_000))
        _ = await settleDetail(until: { false }, yields: 50)
        #expect(calls == 201)
    }

    /// Regression for the earlier `runPushLoad`, which drained a burst of queued follow-ups by
    /// calling itself once per round instead of looping: 200 rounds (above) passes either way,
    /// but a run 25x longer makes a genuinely recursive implementation's linear frame growth show
    /// up as a slow/failing run instead of the flat, fast drain the iterative version gives.
    @Test func aVeryLongRunOfQueuedPushesStillDrainsFlat() async {
        let box = ModelBox()
        var calls = 0
        let target = 5_000
        var loaders = DetailModel.Loaders.stubbed()
        loaders.activity = { _ in
            calls += 1
            if calls < target + 1 { box.model?.schedulePushLoad(.activity, session: "s1") }
            return []
        }
        let model = DetailModel(loaders: loaders)
        box.model = model

        await model.load(.activity, session: "s1")  // call 1, and queues the first push
        #expect(await settleDetail(until: { calls == target + 1 }, yields: 30_000))
        _ = await settleDetail(until: { false }, yields: 50)
        #expect(calls == target + 1)
    }

    /// A burst of pushes for the same feed+session must never start a SECOND overlapping read:
    /// `pushPending` (a `Set`) coalesces the whole burst to at most one follow-up, and the
    /// iterative runner picks it up once the read already in flight returns. Tracking the
    /// loader's own re-entrancy depth is the direct check — it never exceeds one.
    @Test func aBurstOfQueuedPushesNeverRunsTwoReadsForTheSameKeyAtOnce() async {
        var depth = 0
        var maxDepth = 0
        var loaders = DetailModel.Loaders.stubbed()
        loaders.activity = { _ in
            depth += 1
            maxDepth = max(maxDepth, depth)
            defer { depth -= 1 }
            await Task.yield()
            return []
        }
        let model = DetailModel(loaders: loaders)
        await model.load(.activity, session: "s1")  // seeds the cache entry, depth back to 0

        // A tight loop, no `await` between calls: the first schedules the one read that runs,
        // every later call in the same burst finds `pushInFlight` already marked and only queues.
        for _ in 0..<20 { model.schedulePushLoad(.activity, session: "s1") }
        #expect(await settleDetail(until: { depth == 0 && maxDepth > 0 }, yields: 5_000))
        _ = await settleDetail(until: { false }, yields: 100)
        #expect(maxDepth == 1)
    }

    // MARK: - A cancelled browse never strands the files tab on a spinner

    @Test func aCancelledBrowseRestoresTheListingItWasShowing() async {
        var calls = 0
        var loaders = DetailModel.Loaders.stubbed()
        loaders.scratchpad = { _, path in
            calls += 1
            if calls == 2 { throw ShepherdError.cancelled }
            return BrowseListing(path: path ?? "", parent: nil, entries: [])
        }
        let model = DetailModel(loaders: loaders)
        await model.load(.files, session: "s1")
        #expect(model.files["s1"]?.value != nil)

        await model.browse(session: "s1", source: .scratchpad, path: "sub")

        // Navigation has no `.task(id:)` to re-run it, so a stuck `.loading` would be permanent.
        #expect(model.files["s1"]?.isLoading == false)
        #expect(model.files["s1"]?.value != nil)
    }

    @Test func aCancelledFirstBrowseLeavesNoEntryBehind() async {
        var loaders = DetailModel.Loaders.stubbed()
        loaders.worktree = { _, _ in throw CancellationError() }
        let model = DetailModel(loaders: loaders)

        await model.browse(session: "s1", source: .worktree, path: nil)

        #expect(model.files["s1"] == nil)
    }

    // MARK: - Pruning sessions the store no longer lists

    @Test func pruneDropsCachesForSessionsNoLongerActive() async {
        var loaders = DetailModel.Loaders.stubbed()
        loaders.activity = { _ in [self.entry(1, "hi")] }
        let model = DetailModel(loaders: loaders)
        await model.load(.activity, session: "keep")
        await model.load(.activity, session: "drop")
        #expect(model.activity["keep"] != nil)
        #expect(model.activity["drop"] != nil)

        model.prune(activeIDs: ["keep"])

        #expect(model.activity["keep"] != nil)
        #expect(model.activity["drop"] == nil)

        // A push for the pruned session is a session nobody has open any more.
        model.schedulePushLoad(.activity, session: "drop")
        _ = await settleDetail(until: { false }, yields: 50)
        #expect(model.activity["drop"] == nil)
    }
}
