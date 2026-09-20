import Foundation
import ShepherdKit
import Testing

@testable import Shepherd

/// The port of `attachPush`, `attachMergePush` and `attachUsagePush` in `src/push.ts`. Pure: an
/// event in, zero or one intents out.
@MainActor
struct NotificationTriggerTests {
    private func trigger() -> NotificationTrigger {
        NotificationTrigger(subjectFor: { id in id == "s1" ? "TASK-07" : nil })
    }

    private func limits(pct: Double?, resetAt: Int = 1_800_003_600_000) -> UsageLimits {
        UsageLimits(
            session5h: pct.map { .init(pct: $0, resetAt: resetAt) },
            week: nil, perModelWeek: [], credits: nil,
            stale: false, calibratedAt: nil, subscriptionOnly: false)
    }

    // attachPush: `if (status !== "done") return;`
    @Test func onlyADoneStatusNotifies() {
        var t = trigger()
        #expect(
            t.intents(for: .sessionStatus(.init(id: "s1", status: SessionStatus(known: .done))))
                .map(\.kind) == [.done])
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

        #expect(
            t.intents(for: .usageLimits(limits(pct: 91))).isEmpty,
            "one warning per 5-hour window, keyed by resetAt")
        #expect(
            !t.intents(for: .usageLimits(limits(pct: 83, resetAt: 1_800_020_000_000))).isEmpty,
            "a new window warns again")
    }

    @Test func anEventForAnUnknownSessionStillNotifiesUnderItsId() {
        var t = trigger()
        // store.get(id)?.name ?? id — the web falls back to the id rather than staying silent.
        let intent = t.intents(
            for: .sessionStatus(.init(id: "ghost", status: SessionStatus(known: .done)))).first
        #expect(intent?.subject == "ghost")
    }

    @Test func everyOtherFrameIsIgnored() {
        var t = trigger()
        #expect(t.intents(for: .sessionArchived(.init(id: "s1"))).isEmpty)
        #expect(t.intents(for: .sessionRenamed(.init(id: "s1", name: "n", branch: nil))).isEmpty)
        #expect(t.intents(for: .unknown(name: "session:recap", payload: nil)).isEmpty)
    }
}
