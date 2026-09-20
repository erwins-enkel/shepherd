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

        m.gitMerged = ["s1"]
        #expect(!m.actions(for: session).contains(.relaunch), "a merged PR hides relaunch")

        var blocked = PreviewData.session(id: "s2", status: SessionStatus(known: .blocked))
        blocked.claudeSessionId = "claude-2"
        #expect(!m.actions(for: blocked).contains(.stop))
        m.workingBlocked = ["s2": true]
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
        // buffered — so the model drops a frame whose generation has moved on.
        store.apply(recapFrame("s8"))
        _ = await settle(until: { model.recap(for: "s8") != nil }, yields: 50)
        #expect(model.recap(for: "s8") == nil)
    }
}
