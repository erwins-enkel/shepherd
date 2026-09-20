import Foundation
import ShepherdKit
import Testing

@testable import Shepherd

@MainActor
struct ActionsModelTests {
    /// Driven through the injectable reads rather than the network: Task 2 proves the HTTP
    /// mapping, this suite is about state.
    private func model(_ reads: ActionReads = .stub) -> ActionsModel {
        ActionsModel(reads: reads, now: { 1_800_000_000_000 })
    }

    private func frame(_ name: String, _ json: String) -> ServerEvent {
        .unknown(name: name, payload: Data(json.utf8))
    }

    @Test func refreshInstallsTheRecapSnapshot() async {
        let m = model()
        await m.refresh()
        #expect(m.recap(for: "s1")?.headline == "Rate limiter lands")
    }

    @Test func aRefreshThatLostItsRaceIsDropped() async {
        let m = model()
        m.armStaleGeneration()
        await m.refresh()
        #expect(m.recaps.isEmpty, "a superseded snapshot must not be installed")
    }

    /// Arming twice must not leave a second, un-cleared bump waiting for a THIRD read: the flag
    /// is one-shot, not "every read forever" — otherwise every refresh after the armed one would
    /// keep looking superseded too.
    @Test func armStaleGenerationIsOneShot() async {
        let m = model()
        m.armStaleGeneration()
        await m.refresh()
        #expect(m.recaps.isEmpty, "the armed read is still dropped")

        await m.refresh()
        #expect(m.recaps.isEmpty == false, "a later read must install normally")
    }

    /// A frame that lands *while* a read is in flight must survive the snapshot install.
    ///
    /// The socket comes back, `watchConnection()` refreshes; while `GET /api/recaps` is in
    /// flight the server pushes the freshly regenerated recap for `s7`. A wholesale
    /// `recaps = loaded` would put the pre-regenerate recap back and leave it wrong until the
    /// next frame for `s7` — which may never come.
    @Test func aFrameThatLandsDuringAReadSurvivesTheSnapshot() async {
        let gate = RecapGate()
        let m = ActionsModel(reads: gate.reads, now: { 1_800_000_000_000 })
        let reading = Task { await m.refresh() }
        #expect(await settle(until: { gate.parkedCount == 1 }), "the read is in flight")

        m.apply(recapFrame("s7", headline: "regenerated"))
        // An archive frame in the same window: the snapshot must not resurrect what it cleared.
        m.apply(recapFrame("s8", headline: "doomed"))
        m.apply(.sessionArchived(.init(id: "s8")))

        gate.release([
            "s7": Self.recap("s7", headline: "stale"),
            "s8": Self.recap("s8", headline: "also stale"),
            "s9": Self.recap("s9", headline: "fresh"),
        ])
        await reading.value

        #expect(m.recap(for: "s7")?.headline == "regenerated", "the in-flight frame wins")
        #expect(m.recap(for: "s8") == nil, "a recap the archive frame cleared must not come back")
        #expect(m.recap(for: "s9")?.headline == "fresh", "the rest of the snapshot still installs")
    }

    /// Two reads overlap — a slow bootstrap and a reconnect's read, say. The older one returning
    /// last must drop its result rather than replace the newer map.
    @Test func anOlderReadCompletingLastDoesNotOverwriteTheNewerSnapshot() async {
        let gate = RecapGate()
        let m = ActionsModel(reads: gate.reads, now: { 1_800_000_000_000 })
        let older = Task { await m.refresh() }
        #expect(await settle(until: { gate.parkedCount == 1 }))
        let newer = Task { await m.refresh() }
        #expect(await settle(until: { gate.parkedCount == 2 }))

        gate.releaseNewest(["s2": Self.recap("s2", headline: "newer")])
        await newer.value
        gate.release(["s1": Self.recap("s1", headline: "older")])
        await older.value

        #expect(m.recap(for: "s2")?.headline == "newer", "the newer snapshot stands")
        #expect(m.recap(for: "s1") == nil, "an older read landing late must be dropped")
    }

    private func recapFrame(_ id: String, headline: String) -> ServerEvent {
        frame(
            "session:recap",
            #"{"id":"\#(id)","recap":{"sessionId":"\#(id)","state":"ready","headline":"\#(headline)","body":"b","openItems":[],"updatedAt":1}}"#
        )
    }

    fileprivate static func recap(_ id: String, headline: String) -> Recap {
        Recap(
            sessionId: id,
            state: RecapState(known: .ready),
            verdict: nil,
            headline: headline,
            body: "b",
            openItems: [],
            changedFiles: [],
            generatedAt: 1,
            updatedAt: 1)
    }

    /// The relaunch bar's own escape hatch: a note for a session that does not exist at the
    /// moment the command producing it completes (see `ActionBarView.relaunch()`).
    @Test func outcomeNoteIsOneShotAndOnlyAnswersItsOwnSessionID() {
        let m = model()
        #expect(m.consumeOutcomeNote(forSessionID: "s2") == nil, "nothing is pending yet")

        m.recordOutcomeNote("relaunched as TASK-02", forSessionID: "s2")
        #expect(
            m.consumeOutcomeNote(forSessionID: "s1") == nil,
            "a different session must not see another session's note")
        #expect(m.consumeOutcomeNote(forSessionID: "s2") == "relaunched as TASK-02")
        #expect(m.consumeOutcomeNote(forSessionID: "s2") == nil, "consuming it once clears it")
    }

    @Test func recordingAgainReplacesWhateverWasWaiting() {
        let m = model()
        m.recordOutcomeNote("first", forSessionID: "s1")
        m.recordOutcomeNote("second", forSessionID: "s2")
        #expect(m.consumeOutcomeNote(forSessionID: "s1") == nil, "the first note was replaced")
        #expect(m.consumeOutcomeNote(forSessionID: "s2") == "second")
    }

    @Test func aFailedReadLeavesTheLastSnapshotInPlace() async {
        let m = model()
        await m.refresh()
        m.reads = .failing
        await m.refresh()
        #expect(m.recap(for: "s1") != nil, "a failed read must not blank the recap line")
    }

    @Test func aRecapFrameReplacesOneEntry() {
        let m = model()
        m.apply(
            frame(
                "session:recap",
                #"{"id":"s9","recap":{"sessionId":"s9","state":"ready","verdict":"parked","headline":"h9","body":"b","openItems":["x"],"updatedAt":9}}"#
            ))
        #expect(m.recap(for: "s9")?.verdict?.known == .parked)
        #expect(m.recap(for: "s9")?.openItems == ["x"])
    }

    @Test func anAmendmentsFrameReplacesTheWholeList() {
        let m = model()
        m.apply(
            frame(
                "session:amendments",
                #"{"id":"s9","amendments":[{"id":"a1","sessionId":"s9","text":"t","createdAt":1,"retractedAt":null}]}"#
            ))
        #expect(m.amendments(for: "s9").count == 1)
        // An empty array is a genuine all-clear, not "no news".
        m.apply(frame("session:amendments", #"{"id":"s9","amendments":[]}"#))
        #expect(m.amendments(for: "s9").isEmpty)
    }

    @Test func anUndecodableFrameIsIgnoredRatherThanCrashing() {
        let m = model()
        m.apply(frame("session:recap", #"{"nope":true}"#))
        m.apply(frame("session:recap", ""))
        m.apply(frame("some:other:event", "{}"))
        #expect(m.recaps.isEmpty)
    }

    @Test func archivingDropsTheSessionsDerivedState() {
        let m = model()
        m.apply(frame("session:amendments", #"{"id":"s9","amendments":[]}"#))
        m.apply(
            frame(
                "session:recap",
                #"{"id":"s9","recap":{"sessionId":"s9","state":"ready","headline":"h","body":"b","openItems":[],"updatedAt":1}}"#
            ))
        m.apply(.sessionArchived(.init(id: "s9")))
        #expect(m.recap(for: "s9") == nil)
        #expect(m.amendments(for: "s9").isEmpty)
    }

    @Test func actionsGoThroughActionRulesWithTheInjectedSeams() {
        let m = model()
        var session = PreviewData.session(id: "s1", status: SessionStatus(known: .idle))
        session.claudeSessionId = "claude-1"
        #expect(m.actions(for: session).contains(.relaunch))

        m.gitMerged = { $0 == "s1" }
        #expect(!m.actions(for: session).contains(.relaunch), "a merged PR hides relaunch")

        var blocked = PreviewData.session(id: "s2", status: SessionStatus(known: .blocked))
        blocked.claudeSessionId = "claude-2"
        #expect(!m.actions(for: blocked).contains(.stop))
        m.workingBlocked = { ["s2": true] }
        #expect(m.actions(for: blocked).contains(.stop))
    }

    @Test func teardownEndsTheEventSubscription() {
        let m = model()
        m.teardown()
        #expect(!m.isSubscribed)
    }

    /// A frame for a session that was never seen adds an entry; pruning to the live ids drops
    /// everything the store no longer lists. Bounded state is the point — a long-running app
    /// must not accumulate one recap and one amendment list per session it ever saw.
    @Test func pruningKeepsOnlyTheLiveSessions() {
        let m = model()
        for id in ["s1", "s2", "s3"] {
            m.apply(
                frame(
                    "session:recap",
                    #"{"id":"\#(id)","recap":{"sessionId":"\#(id)","state":"ready","headline":"h","body":"b","openItems":[],"updatedAt":1}}"#
                ))
            m.apply(frame("session:amendments", #"{"id":"\#(id)","amendments":[]}"#))
        }
        #expect(m.recaps.count == 3)

        m.prune(to: ["s2"])

        #expect(m.recaps.keys.sorted() == ["s2"])
        #expect(m.amendments.keys.sorted() == ["s2"])
    }

    /// `native/README.md`, "Reconcile after a drop": the bootstrap read is not the only read
    /// this model may ever do. Frames are lost while the socket is down, so every return to
    /// `.live` re-reads the snapshot — and only a return to `.live` does, because `.connecting`
    /// is published on every retry against a server the store cannot yet reach.
    @Test func everyReconnectReReadsTheSnapshotAndTeardownStopsThat() async {
        let counter = ReadCounter()
        let m = ActionsModel(
            reads: ActionReads(recaps: {
                await MainActor.run { counter.count += 1 }
                return try await ActionReads.stub.recaps()
            }),
            now: { 1_800_000_000_000 })
        let box = ConnectionBox()
        box.state = .connecting
        m.connectionSource = ConnectionSource(read: { box.state }, abandon: {})
        m.watchConnection()

        box.state = .live
        #expect(await settle(until: { counter.count == 1 }), "coming up live reads once")
        // The counter moves when the read *starts*; the snapshot lands a hop later.
        #expect(await settle(until: { m.recap(for: "s1") != nil }), "and installs what it read")

        // A drop and a retry that never reach `.live` read nothing.
        box.state = .offline(message: "down")
        box.state = .connecting
        #expect(await settle(until: { counter.count > 1 }, yields: 50) == false)

        box.state = .live
        #expect(await settle(until: { counter.count == 2 }), "the reconnect reads again")

        m.teardown()
        box.state = .connecting
        box.state = .live
        #expect(await settle(until: { counter.count > 2 }, yields: 50) == false)
    }

    /// Yields until `condition` holds or the budget runs out. Everything here lands on the main
    /// actor, so there is nothing to sleep for.
    private func settle(until condition: () -> Bool, yields: Int = 500) async -> Bool {
        for _ in 0..<yields {
            if condition() { return true }
            await Task.yield()
        }
        return condition()
    }
}

/// Counts reads from inside a `@Sendable` closure. Main-actor isolated, so it is `Sendable`
/// without a lock and the test can read it directly.
@MainActor
final class ReadCounter {
    var count = 0
}

/// An `ActionReads` whose reads park until the test releases them by hand.
///
/// The only way to assert what happens *during* a read — a frame landing mid-flight, two reads
/// overlapping — without a server or a timing guess. Main-actor isolated, so it is `Sendable`
/// without a lock. Preferred over widening the `#if DEBUG` `armStaleGeneration` seam: these
/// tests are about the ordering production reads actually have, not about a seam.
@MainActor
final class RecapGate {
    private var parked: [CheckedContinuation<[String: Recap], Never>] = []

    var reads: ActionReads { ActionReads(recaps: { [self] in await self.park() }) }

    var parkedCount: Int { parked.count }

    private func park() async -> [String: Recap] {
        await withCheckedContinuation { continuation in
            parked.append(continuation)
        }
    }

    /// Releases the oldest parked read.
    func release(_ snapshot: [String: Recap]) {
        guard !parked.isEmpty else { return }
        parked.removeFirst().resume(returning: snapshot)
    }

    /// Releases the newest parked read, which is how a *newer* read lands first.
    func releaseNewest(_ snapshot: [String: Recap]) {
        guard !parked.isEmpty else { return }
        parked.removeLast().resume(returning: snapshot)
    }
}

/// The store-backed half: the real `AppExtension` initialiser, the real `SessionStore.events()`
/// tap, and the teardown that has to end it. Serialized because it builds an `AppModel`.
@MainActor
@Suite(.serialized)
struct ActionsModelTapTests {
    /// A store with no socket and no `start()`: `apply(_:)` is driven by hand, which is all this
    /// suite needs — it is about the tap, not about the network.
    private func makeStore() throws -> SessionStore {
        let profile = ServerProfile(
            name: "fake",
            baseURL: URL(string: "http://127.0.0.1:1")!,
            mode: .local,
            credentialKey: "actions-tap")
        let client = try ShepherdClient(profile: profile, credentials: InMemoryCredentialStore())
        return SessionStore(client: client)
    }

    private func makeApp() -> AppModel {
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
    }

    /// Yields until `condition` holds or the budget runs out. The tap delivers on the main
    /// actor, so there is nothing here to sleep for.
    private func settle(until condition: () -> Bool, yields: Int = 500) async -> Bool {
        for _ in 0..<yields {
            if condition() { return true }
            await Task.yield()
        }
        return condition()
    }

    private func recapFrame(_ id: String) -> ServerEvent {
        .unknown(
            name: "session:recap",
            payload: Data(
                #"{"id":"\#(id)","recap":{"sessionId":"\#(id)","state":"ready","headline":"h","body":"b","openItems":[],"updatedAt":1}}"#
                    .utf8))
    }

    /// A refresh prunes what the store no longer lists. The recap map is replaced wholesale by
    /// the snapshot, so the amendment lists — which only ever arrive as events — are what this
    /// actually bounds. The guard matters as much as the pruning: a store whose own list has not
    /// arrived yet lists nothing, and that must not be read as "every session is gone".
    @Test func aRefreshPrunesTheAmendmentCacheToTheStoresLiveSessions() async throws {
        let store = try makeStore()
        let model = ActionsModel(store: store, app: makeApp())
        model.reads = .stub
        model.apply(amendmentsFrame("s1"))
        model.apply(amendmentsFrame("s9"))

        // The store still lists nothing, so nothing is pruned.
        await model.refresh()
        #expect(model.amendments(for: "s9").count == 1, "an empty list must prune nothing")

        store.apply(.sessionNew(PreviewData.session(id: "s1")))
        await model.refresh()
        #expect(model.amendments(for: "s1").count == 1)
        #expect(model.amendments(for: "s9").isEmpty, "the store no longer lists s9")
        model.teardown()
    }

    private func amendmentsFrame(_ id: String) -> ServerEvent {
        .unknown(
            name: "session:amendments",
            payload: Data(
                #"{"id":"\#(id)","amendments":[{"id":"a-\#(id)","sessionId":"\#(id)","text":"t","createdAt":1,"retractedAt":null}]}"#
                    .utf8))
    }

    /// The reconcile loop against a real store's caches: coming back live re-reads the snapshot
    /// *and* prunes to what the store now lists. The bootstrap read is deliberately made to fail
    /// first, so a recap appearing at all can only be the reconnect's doing.
    @Test func aReconnectReReadsAndPrunesAgainstTheStore() async throws {
        let store = try makeStore()
        let model = ActionsModel(store: store, app: makeApp())
        model.reads = .failing
        model.apply(amendmentsFrame("s9"))
        store.apply(.sessionNew(PreviewData.session(id: "s1")))

        let box = ConnectionBox()
        box.state = .connecting
        model.connectionSource = ConnectionSource(read: { box.state }, abandon: {})
        model.watchConnection()

        // Let the failing bootstrap land: it installs nothing and prunes nothing.
        _ = await settle(until: { model.recap(for: "s1") != nil }, yields: 50)
        #expect(model.recap(for: "s1") == nil)
        #expect(model.amendments(for: "s9").count == 1)

        model.reads = .stub
        box.state = .live
        #expect(
            await settle(until: { model.recap(for: "s1") != nil }),
            "the socket coming back re-reads the snapshot")
        #expect(model.amendments(for: "s9").isEmpty, "and prunes what the store no longer lists")
        model.teardown()
    }

    /// The two guards are separate facts. A read that lost its race only moves `readSequence`;
    /// that must not silently kill a perfectly live event tap — which is what one shared counter
    /// did, while `isSubscribed` went on claiming the tap was there.
    @Test func aStaleReadDoesNotKillTheEventTap() async throws {
        let store = try makeStore()
        let model = ActionsModel(store: store, app: makeApp())
        model.reads = .stub
        model.armStaleGeneration()
        await model.refresh()
        #expect(model.recaps.isEmpty, "the superseded snapshot is still dropped")

        store.apply(recapFrame("s7"))
        #expect(await settle(until: { model.recap(for: "s7") != nil }), "the tap is still live")
        #expect(model.isSubscribed)
        model.teardown()
    }

    @Test func theStoreInitTapsEventsAndTeardownEndsTheTap() async throws {
        let store = try makeStore()
        let model = ActionsModel(store: store, app: makeApp())
        #expect(model.isSubscribed)

        store.apply(recapFrame("s9"))
        #expect(await settle(until: { model.recap(for: "s9") != nil }))

        model.teardown()
        #expect(!model.isSubscribed)

        // A frame after teardown reaches nothing. Cancelling the tap task is not on its own
        // enough — a cancelled AsyncStream iterator still returns an element that is already
        // buffered — so the model drops any frame that arrives once it is torn down.
        store.apply(recapFrame("s8"))
        _ = await settle(until: { model.recap(for: "s8") != nil }, yields: 50)
        #expect(model.recap(for: "s8") == nil)
    }
}
