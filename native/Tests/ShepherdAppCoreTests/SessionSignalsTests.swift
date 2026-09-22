import Foundation
import ShepherdKit
import Testing

@testable import ShepherdAppCore

extension CoreSeamTests {
/// The integration lane's cross-stream seams, and what the action bar makes of them.
///
/// `.serialized` and `resetStreamSeams()` in `init` for the same reason `SlotTests` is: these are
/// per-process seams, so a test that fills one would otherwise leak it into whatever runs next —
/// including the suites that assert the conservative default.
@MainActor
@Suite(.serialized)
struct SessionSignalsTests {
    init() { resetStreamSeams() }

    private func git(state: PrStateKnown) -> GitState {
        GitState(state: .init(known: state), checks: .init(known: .success), deployConfigured: false)
    }

    private func model() -> ActionsModel {
        ActionsModel(reads: .stub, now: { 1_800_000_000_000 })
    }

    private func session(id: String, status: SessionStatusKnown) -> Session {
        var session = PreviewData.session(id: id, status: SessionStatus(known: status))
        session.claudeSessionId = "claude-\(id)"
        return session
    }

    @Test func bothSeamsAnswerConservativelyUntilTheyAreConnected() {
        #expect(SessionSignals.workingBlocked().isEmpty)
        #expect(SessionSignals.usageLimits() == nil)
        #expect(!SessionSignals.gitMerged("s1"))
    }

    @Test func theTwoNewSeamsDefaultToTheConservativeAnswer() {
        SessionSignals.reset()
        #expect(SessionSignals.planQuestionsUnanswered("sess_x") == false)
        #expect(SessionSignals.manualStepsOutstanding().isEmpty)
    }

    @Test func resetRestoresTheShippedDefaultsAfterAnAssignment() {
        SessionSignals.usageLimits = {
            UsageLimits(perModelWeek: [], stale: false, subscriptionOnly: false)
        }
        SessionSignals.planQuestionsUnanswered = { _ in true }
        SessionSignals.manualStepsOutstanding = { ["sess_x": 3] }
        SessionSignals.reset()
        #expect(SessionSignals.usageLimits() == nil)
        #expect(SessionSignals.planQuestionsUnanswered("sess_x") == false)
        #expect(SessionSignals.manualStepsOutstanding().isEmpty)
    }

    /// Only a `.ready` entry holding a merged PR is a merge. Everything else — no entry at all,
    /// a read in flight, a failed read, and the contract's "no forge, or no PR" `nil` — reads as
    /// not merged, so Relaunch stays offered rather than vanishing on a missing answer.
    @Test func onlyAReadyMergedSnapshotCounts() {
        #expect(!SessionSignals.isMerged(nil))
        #expect(!SessionSignals.isMerged(.loading))
        #expect(!SessionSignals.isMerged(.failed("boom")))
        #expect(!SessionSignals.isMerged(.ready(nil)))
        #expect(!SessionSignals.isMerged(.ready(git(state: .open))))
        #expect(!SessionSignals.isMerged(.ready(git(state: .closed))))
        #expect(SessionSignals.isMerged(.ready(git(state: .merged))))
    }

    /// `connect(_:)` against a model with no activation: there are no extensions to read, and
    /// both seams have to say so rather than crash or invent an answer. This is also the state a
    /// launch is in between `installAll` and the first `activate(_:)`.
    @Test func connectingToAnInactiveModelStillAnswers() {
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: CoreTestSupport.environment(defaults: defaults))

        SessionSignals.connect(app)

        #expect(SessionSignals.workingBlocked().isEmpty)
        #expect(SessionSignals.usageLimits() == nil)
        #expect(!SessionSignals.gitMerged("s1"))
    }

    @Test func usageSeamReadsTheCurrentSidebarAndReleasesItsActivation() throws {
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: CoreTestSupport.environment(defaults: defaults))
        let profile = ServerProfile(
            name: "usage", baseURL: URL(string: "https://usage.example.ts.net")!, mode: .remote)
        let store = try SessionStore(profile: profile, credentials: InMemoryCredentialStore())
        let sidebar = SidebarModel(store: store, app: app)
        sidebar.reads = .stub
        app.liveExtensions = [(ObjectIdentifier(SidebarModel.self), sidebar)]
        SessionSignals.connect(app)
        defer {
            app.teardown()
            SessionSignals.reset()
        }

        #expect(SessionSignals.usageLimits() == nil)
        let limits = UsageLimits(
            session5h: .init(pct: 95, resetAt: 1_800_000_000_000),
            perModelWeek: [], stale: false, subscriptionOnly: false)
        store.reconcileUsageLimits(limits)
        #expect(SessionSignals.usageLimits()?.session5h?.pct == 95)
        var pushed = limits
        pushed.session5h?.pct = 7
        store.apply(.usageLimits(pushed))
        #expect(SessionSignals.usageLimits()?.session5h?.pct == 7)
        app.tearDownExtensions()
        #expect(SessionSignals.usageLimits() == nil, "the seam must not retain the outgoing sidebar")
    }

    /// The parity gap note 2 of the S4 PR names: a `blocked` session the poller found still
    /// producing output displays as running, and a running session is one Stop acts on. Straight
    /// through the shipped seam — the model here is built with its default closures, exactly as
    /// `AppModel.activate` builds it.
    @Test func aBlockedButWorkingSessionOffersStop() {
        let m = model()
        let blocked = session(id: "b", status: .blocked)
        #expect(!m.actions(for: blocked).contains(.stop), "blocked with no flag stays blocked")

        SessionSignals.workingBlocked = { ["b": true] }
        #expect(m.actions(for: blocked).contains(.stop))
    }

    /// The other half of note 2: relaunching a session whose PR has already merged would fork
    /// work that is already in `main`, so the button goes away once S2's snapshot says merged.
    @Test func aMergedSessionHidesRelaunch() {
        let m = model()
        let merged = session(id: "m", status: .idle)
        #expect(m.actions(for: merged).contains(.relaunch), "no git snapshot keeps it offered")

        SessionSignals.gitMerged = { $0 == "m" }
        #expect(!m.actions(for: merged).contains(.relaunch))
        #expect(
            m.actions(for: session(id: "other", status: .idle)).contains(.relaunch),
            "the seam is per session, not a global switch")
    }
}
}
