import Foundation
import ShepherdKit
import Testing

@testable import Shepherd

/// The port of `attachPush`, `attachMergePush` and `attachUsagePush` in `src/push.ts`. Pure: an
/// event in, zero or one intents out.
@MainActor
struct NotificationTriggerTests {
    /// The wall clock every test starts from, in ms since the epoch — the unit of `resetAt`
    /// (`src/usage-limits.ts`: `resetAt: number; // ms epoch of window reset`).
    private static let nowMs = 1_800_000_000_000
    /// One hour past `nowMs`: a 5-hour window that has *not* elapsed yet.
    private static let openWindow = 1_800_003_600_000

    private func trigger(now: Int = nowMs) -> NotificationTrigger {
        NotificationTrigger(subjectFor: { id in id == "s1" ? "TASK-07" : nil }, now: { now })
    }

    private func limits(pct: Double?, resetAt: Int = openWindow) -> UsageLimits {
        UsageLimits(
            session5h: pct.map { .init(pct: $0, resetAt: resetAt) },
            week: nil, perModelWeek: [], credits: nil,
            stale: false, calibratedAt: nil, subscriptionOnly: false)
    }

    /// A `session:new` frame's payload. `#/components/schemas/Session` lists ~30 required
    /// properties; this fixture passes only the 20 that are also **non-nullable** — the other
    /// ~10 required properties are nullable, so the generator already defaults them to `nil`,
    /// same as the genuinely optional ones.
    private func session(id: String) -> Session {
        Session(
            id: id, desig: "TASK-07", name: "session", prompt: "do the thing",
            repoPath: "/repos/demo", baseBranch: "main", worktreePath: "/repos/demo-\(id)",
            isolated: false, herdrSession: "herdr-\(id)", herdrAgentId: "agent-\(id)",
            claudeSessionId: "claude-\(id)", readyToMerge: false, autopilotPaused: false,
            autopilotComplete: false, auto: false, status: SessionStatus(known: .running),
            lastState: Components.Schemas.HerdrState(known: .working),
            createdAt: 1_700_000_000, updatedAt: 1_700_000_001, manualSteps: [])
    }

    // attachPush: `if (status !== "done") return;`
    @Test func onlyADoneStatusNotifies() {
        var t = trigger()
        let done = t.intents(
            for: .sessionStatus(.init(id: "s1", status: SessionStatus(known: .done))))
        #expect(done.map(\.kind) == [.done])
        // `store.get(id)?.name ?? id`: the resolver is really consulted. Without this the banner
        // could read a raw session UUID and every other assertion would still pass.
        #expect(done.first?.subject == "TASK-07")
        for status: SessionStatusKnown in [.running, .idle, .blocked, .archived] {
            #expect(
                t.intents(for: .sessionStatus(.init(id: "s1", status: SessionStatus(known: status))))
                    .isEmpty, "\(status) must not notify")
        }
    }

    // attachPush: `if (!block) return;` — a cleared block is good news, not a banner.
    @Test func onlyANonNullBlockNotifies() {
        var t = trigger()
        let block = BlockReason(shape: .init(value1: .yesNo), options: [], tail: [])
        let intents = t.intents(for: .sessionBlock(.init(id: "s1", block: block)))
        #expect(intents.map(\.kind) == [.blocked])
        #expect(intents.first?.blockShape == .yesNo)
        #expect(intents.first?.subject == "TASK-07")
        #expect(t.intents(for: .sessionBlock(.init(id: "s1", block: nil))).isEmpty)
    }

    @Test func onlyAReadyTrueNotifies() {
        var t = trigger()
        #expect(t.intents(for: .sessionReady(.init(id: "s1", ready: true))).map(\.kind) == [.ready])
        #expect(t.intents(for: .sessionReady(.init(id: "s1", ready: false))).isEmpty)
    }

    // attachMergePush: manual_steps first, then merge_error / rebase_cap; everything else ignored.
    @Test func theThreeMergeAttentionStatesNotifyAndNothingElseDoes() {
        var t = trigger()
        func status(_ state: String?) -> AutoMergeStatus {
            AutoMergeStatus(
                repoPath: "/repos/a", enabled: true, state: state, detail: "TASK-07",
                sessionId: "s1")
        }
        #expect(t.intents(for: .automergeStatus(status("manual_steps"))).map(\.kind) == [.manualSteps])
        #expect(t.intents(for: .automergeStatus(status("merge_error"))).map(\.kind) == [.mergeError])
        #expect(t.intents(for: .automergeStatus(status("rebase_cap"))).map(\.kind) == [.rebaseCap])
        #expect(t.intents(for: .automergeStatus(status("merging"))).isEmpty)
        #expect(t.intents(for: .automergeStatus(status(nil))).isEmpty)
    }

    // `const desig = detail ?? repoPath; const target = sessionId ?? repoPath;`
    @Test func aMergeAttentionWithoutASessionFallsBackToTheRepoPath() {
        var t = trigger()
        let orphan = AutoMergeStatus(
            repoPath: "/repos/a", enabled: true, state: "merge_error", detail: nil, sessionId: nil)
        let intent = t.intents(for: .automergeStatus(orphan)).first
        #expect(intent?.subject == "/repos/a")
        #expect(intent?.sessionID == "/repos/a")
    }

    // attachUsagePush: `if (!session5h || session5h.pct < USAGE_WARN_PCT) return;`
    @Test func theUsageWarningFiresAtEightyPercentAndOncePerWindow() {
        var t = trigger()
        #expect(t.intents(for: .usageLimits(limits(pct: nil))).isEmpty)
        #expect(t.intents(for: .usageLimits(limits(pct: 79))).isEmpty)

        let first = t.intents(for: .usageLimits(limits(pct: 83)))
        #expect(first.map(\.kind) == [.usageLimit])
        #expect(first.first?.pct == 83)
        #expect(first.first?.sessionID == nil)

        // `if (sent) store.setSetting(USAGE_WARNED_KEY, …)`: the poster confirms delivery.
        t.usageWarningPosted(for: first.first!)
        #expect(
            t.intents(for: .usageLimits(limits(pct: 91))).isEmpty,
            "one warning per 5-hour window, while the clock is still inside it")
    }

    /// The hook is total: only a `.usageLimit` intent can latch. The natural Task 6 call site is
    /// `trigger.usageWarningPosted(for: intent)` regardless of which kind was just posted, so a
    /// `.done` or `.blocked` intent passed by mistake must be a no-op, not a latch on its
    /// `resetAt`. The `.done` intent below deliberately carries a non-`nil`, *future* `resetAt`
    /// (`openWindow`, not `0`): with a `nil` `resetAt` the optional bind alone would already
    /// reject it, so the kind check itself would never be exercised. With a real `resetAt`,
    /// dropping `intent.kind == .usageLimit` from the guard would still latch the window, which
    /// the assertion below catches by seeing the next in-window frame wrongly suppressed.
    @Test func postingANonUsageLimitIntentDoesNotLatch() {
        var t = trigger()
        #expect(t.intents(for: .usageLimits(limits(pct: 83))).map(\.kind) == [.usageLimit])
        t.usageWarningPosted(
            for: NotificationIntent(
                kind: .done, sessionID: "s1", subject: "TASK-07", resetAt: Self.openWindow))
        #expect(
            t.intents(for: .usageLimits(limits(pct: 91))).map(\.kind) == [.usageLimit],
            "a non-usage-limit intent must not latch the usage window, even with a real resetAt")
    }

    /// Self-guarding: a `.usageLimit` intent with `resetAt == nil` must not latch, and — starting
    /// from a *real*, already-confirmed latch rather than an unlatched trigger — an invalid
    /// confirmation must not erase that existing latch either. A body that unconditionally
    /// assigned `warnedUntil = intent.resetAt` (skipping the guard entirely) would pass the old,
    /// unlatched version of this test — `resetAt` is `nil` either way — but would silently wipe
    /// out a real suppression the moment a `.done`/`.blocked` intent, or a `.usageLimit` intent
    /// missing its `resetAt`, was passed to `usageWarningPosted` afterwards. Note the actual
    /// failure direction of such a mistake: `warnedUntil = 0` would *not* "permanently disable"
    /// the warning — `now() < 0` is false for any real wall clock, so the suppression guard would
    /// never trigger and the warning would fire on *every* subsequent frame instead.
    @Test func postingAUsageLimitIntentWithoutAResetAtDoesNotLatch() {
        var t = trigger()
        let valid = t.intents(for: .usageLimits(limits(pct: 83)))
        #expect(valid.map(\.kind) == [.usageLimit])
        t.usageWarningPosted(for: valid.first!)
        #expect(
            t.intents(for: .usageLimits(limits(pct: 90))).isEmpty,
            "the valid confirmation latches the window")

        // Invalid confirmation #1: the right kind, but no resetAt.
        t.usageWarningPosted(
            for: NotificationIntent(kind: .usageLimit, sessionID: nil, subject: "5h"))
        #expect(
            t.intents(for: .usageLimits(limits(pct: 91))).isEmpty,
            "a usageLimit intent with no resetAt must not latch — nor erase the existing latch")

        // Invalid confirmation #2: the wrong kind, no resetAt either.
        t.usageWarningPosted(
            for: NotificationIntent(kind: .done, sessionID: "s1", subject: "TASK-07"))
        #expect(
            t.intents(for: .usageLimits(limits(pct: 92))).isEmpty,
            "a non-usage-limit intent must not erase the existing latch either")
    }

    /// The threshold is read off the constant so re-tuning `usageWarnPercent` cannot leave a
    /// test asserting the old number. `>` instead of `>=` would make the warning arrive at 81 %.
    @Test func theUsageThresholdIsInclusiveAndComparesTheRawValue() {
        let warn = Double(NotificationTrigger.usageWarnPercent)
        var t = trigger()
        #expect(t.intents(for: .usageLimits(limits(pct: warn - 1))).isEmpty, "just below")
        // The web compares the raw number (`session5h.pct < USAGE_WARN_PCT`); rounding first
        // would fire here. `clampPct` already rounds upstream, so today nothing sends this —
        // the assertion pins the semantics, not the producer.
        #expect(t.intents(for: .usageLimits(limits(pct: warn - 0.5))).isEmpty, "raw, not rounded")
        let atThreshold = t.intents(for: .usageLimits(limits(pct: warn)))
        #expect(atThreshold.map(\.kind) == [.usageLimit], "exactly the threshold warns")
        #expect(atThreshold.first?.pct == NotificationTrigger.usageWarnPercent)
    }

    /// The latch belongs to the poster, not to the intent. `notify()` in `src/push.ts` returns
    /// `false` — it does not throw — when the app is focused or the cooldown is open, and the
    /// web writes `USAGE_WARNED_KEY` only inside `.then((sent) => …)`. A banner the gate dropped
    /// must therefore leave the window un-warned so a later frame can still deliver it.
    @Test func aWarningNobodyPostedDoesNotBurnTheWindow() {
        var t = trigger()
        #expect(t.intents(for: .usageLimits(limits(pct: 83))).map(\.kind) == [.usageLimit])
        // No `usageWarningPosted` — the gate suppressed it.
        #expect(
            t.intents(for: .usageLimits(limits(pct: 92))).map(\.kind) == [.usageLimit],
            "an unposted warning must not silence the rest of the window")
        #expect(
            t.intents(for: .usageLimits(limits(pct: 99))).map(\.kind) == [.usageLimit])
    }

    /// `if (now() < warned) return;` — the suppression is a wall clock. `resetAt` can *move*
    /// inside one window: `src/usage-limits.ts` derives a synthetic `now + period` anchor that a
    /// later real scrape replaces, and value equality would re-arm and warn twice.
    @Test func aResetAtThatMovesInsideTheWarnedWindowDoesNotWarnAgain() {
        var t = trigger()
        let posted = t.intents(for: .usageLimits(limits(pct: 83)))
        #expect(posted.map(\.kind) == [.usageLimit])
        t.usageWarningPosted(for: posted.first!)
        #expect(
            t.intents(for: .usageLimits(limits(pct: 90, resetAt: Self.openWindow + 900_000)))
                .isEmpty,
            "a scrape that nudges resetAt is the same window, not a new one")
    }

    /// The other half of the wall clock: once the window has genuinely elapsed, the *same*
    /// `resetAt` must warn again. Value equality would suppress it forever.
    @Test func anElapsedWindowWarnsAgainEvenAtTheSameResetAt() {
        // A clock already past `openWindow`.
        var t = trigger(now: Self.openWindow + 1)
        let posted = t.intents(for: .usageLimits(limits(pct: 83)))
        #expect(posted.map(\.kind) == [.usageLimit])
        t.usageWarningPosted(for: posted.first!)
        #expect(
            t.intents(for: .usageLimits(limits(pct: 83))).map(\.kind) == [.usageLimit],
            "now() >= warned: the window is over, so it warns again")
    }

    /// The contract types `pct` as a bare `number` with no bounds, and `Int(_:)` traps on a
    /// Double outside `Int`'s range — a server that stopped clamping would crash the app.
    @Test func anOutOfRangePercentIsClampedRatherThanTrapping() {
        var t = trigger()
        #expect(t.intents(for: .usageLimits(limits(pct: 1e30))).first?.pct == 100)
        #expect(t.intents(for: .usageLimits(limits(pct: .infinity))).first?.pct == 100)
    }

    @Test func anEventForAnUnknownSessionStillNotifiesUnderItsId() {
        var t = trigger()
        // store.get(id)?.name ?? id — the web falls back to the id rather than staying silent.
        let intent = t.intents(
            for: .sessionStatus(.init(id: "ghost", status: SessionStatus(known: .done)))).first
        #expect(intent?.subject == "ghost")
    }

    /// Repeats are deliberate. `attachPush` is stateless too: de-duplication is the gate's 120 s
    /// cooldown (`PushService.withinCooldown`, keyed `done:<id>`), which Task 6 owns. Do not
    /// "fix" this by adding a last-status map to the trigger — that would swallow a genuine
    /// second completion after the cooldown had expired.
    @Test func repeatedIdenticalFramesEachProduceAnIntent() {
        var t = trigger()
        let frame = ServerEvent.sessionStatus(.init(id: "s1", status: SessionStatus(known: .done)))
        #expect(t.intents(for: frame).map(\.kind) == [.done])
        #expect(t.intents(for: frame).map(\.kind) == [.done])
    }

    @Test func everyOtherFrameIsIgnored() {
        var t = trigger()
        #expect(t.intents(for: .sessionNew(session(id: "s1"))).isEmpty)
        #expect(t.intents(for: .sessionArchived(.init(id: "s1"))).isEmpty)
        #expect(t.intents(for: .sessionRenamed(.init(id: "s1", name: "n", branch: nil))).isEmpty)
        #expect(t.intents(for: .unknown(name: "session:recap", payload: nil)).isEmpty)
    }

    /// `session:recap` stays ignored now that S4 has merged and declared it, and this pins that
    /// as a decision rather than an oversight: a frame carrying a real `needs_attention` recap
    /// still produces nothing.
    ///
    /// The web has no recap notification to port. `NotifyInput.kind` in `src/push.ts` has no
    /// recap case, nothing in that file or in `src/ready-notify.ts` subscribes to the event, and
    /// `deriveTabState` — the badge's reference — does not read recaps either. A recap reaches
    /// the operator through in-app surfaces only: S4's "Handlungsbedarf" line and the
    /// `recap-attention` signal in `src/attention-core.ts`. Adding an arm here would invent a
    /// banner the web does not send.
    @Test func aRecapFrameIsIgnoredEvenWhenItAsksForAttention() {
        var t = trigger()
        let payload = Data(
            #"{"id":"s1","recap":{"verdict":"needs_attention","headline":"h","openItems":["x"]}}"#
                .utf8)
        #expect(t.intents(for: .unknown(name: "session:recap", payload: payload)).isEmpty)
    }
}
