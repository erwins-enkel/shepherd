import Foundation
import ShepherdKit
import Testing

@testable import ShepherdAppCore

extension CoreSeamTests {
/// The port of `buildPayload` + `NOTIFY_TEXT` in `src/push.ts`. Each test names the web case it
/// pins; the copy itself lives in the catalogs and is only assembled here.
@MainActor
struct NotificationCopyTests {
    private func intent(
        _ kind: NotificationKind,
        subject: String = "TASK-07",
        sessionID: String? = "s1",
        blockShape: BlockShapeCopy? = nil,
        pct: Int? = nil,
        resetAt: Int? = nil
    ) -> NotificationIntent {
        NotificationIntent(
            kind: kind, sessionID: sessionID, subject: subject, blockShape: blockShape,
            pct: pct, resetAt: resetAt)
    }

    @Test func titlesCarryTheSubject() {
        #expect(NotificationCopy.title(intent(.done)) == L.t("native_notify_done_title", "TASK-07"))
        #expect(
            NotificationCopy.title(intent(.blocked, blockShape: .stall))
                == L.t("native_notify_blocked_title", "TASK-07"))
        #expect(NotificationCopy.title(intent(.ready)) == L.t("native_notify_ready_title", "TASK-07"))
        #expect(
            NotificationCopy.title(intent(.manualSteps))
                == L.t("native_notify_manual_steps_title", "TASK-07"))
        // The two merge-train titles name no session: the web's are bare strings too.
        #expect(NotificationCopy.title(intent(.mergeError)) == L.t("native_notify_merge_error_title"))
        #expect(NotificationCopy.title(intent(.rebaseCap)) == L.t("native_notify_rebase_cap_title"))
        #expect(
            NotificationCopy.title(intent(.usageLimit, sessionID: nil, pct: 83))
                == L.t("native_notify_usage_title", "83"))
    }

    @Test func theBlockedBodyIsTheHoldLineForItsShape() {
        #expect(
            NotificationCopy.body(intent(.blocked, blockShape: .menu)) == L.t("hold_blocked_menu"))
        #expect(
            NotificationCopy.body(intent(.blocked, blockShape: .yesNo))
                == L.t("hold_blocked_yes_no"))
        #expect(
            NotificationCopy.body(intent(.blocked, blockShape: .awaitingInput))
                == L.t("hold_blocked_awaiting_input"))
        #expect(
            NotificationCopy.body(intent(.blocked, blockShape: .stall))
                == L.t("hold_blocked_stall"))
        #expect(
            NotificationCopy.body(intent(.blocked, blockShape: .quota(.rework)))
                == L.t("hold_quota_rework"))
        #expect(
            NotificationCopy.body(intent(.blocked, blockShape: .quota(nil)))
                == L.t("hold_blocked_generic"),
            "a quota block with no kind falls back to blocked-generic, exactly as the web does")
        #expect(
            NotificationCopy.body(intent(.blocked, blockShape: nil)) == L.t("hold_blocked_generic"))
    }

    @Test func mergeBodiesNameTheDesignation() {
        #expect(
            NotificationCopy.body(intent(.mergeError, subject: "TASK-07"))
                == L.t("native_notify_merge_error_body", "TASK-07"))
        #expect(
            NotificationCopy.body(intent(.rebaseCap, subject: "TASK-07"))
                == L.t("native_notify_rebase_cap_body", "TASK-07"))
    }

    /// `resetAt` is **milliseconds** — the single most load-bearing unit in this stream. The
    /// assertion is the exact string, built from the same ms→s conversion the copy does: the
    /// machine's time zone is applied on both sides and cancels, so the only thing under test
    /// is the unit.
    ///
    /// Anything weaker does not survive the mutation it exists to catch. Deleting the `/ 1_000`
    /// puts the reset in the year 59,000 — still a perfectly well-formed, similarly long
    /// `hour():minute()` string — so "longer than the plain body" and "different from the plain
    /// body" both stay true while the banner tells the operator the wrong time. The two chosen
    /// instants are nine hours apart in the day, so no time zone can make them format alike.
    @Test func theUsageBodyNamesTheResetTimeOnlyWhenItHasOne() {
        let plain = NotificationCopy.body(intent(.usageLimit, sessionID: nil, pct: 83))
        #expect(plain == L.t("native_notify_usage_body"))

        let resetAt = 1_800_003_600_000
        let locale = Locale(identifier: "en_US")
        let at = NotificationCopy.body(
            intent(.usageLimit, sessionID: nil, pct: 83, resetAt: resetAt), locale: locale)
        let expected = L.t(
            "native_notify_usage_body_reset",
            Date(timeIntervalSince1970: Double(resetAt) / 1_000)
                .formatted(.dateTime.hour().minute().locale(locale)))
        #expect(at == expected)
        #expect(at != plain, "and it is not the body that names no time at all")
    }

    @Test func blockShapeReadsTheOpenEnumAndItsQuotaKind() {
        let stall = BlockReason(shape: .init(value1: .stall), options: [], tail: [])
        #expect(NotificationCopy.blockShape(of: stall) == .stall)

        let quota = BlockReason(
            shape: .init(value1: .quota), options: [], tail: [],
            quotaKind: .init(value1: .review))
        #expect(NotificationCopy.blockShape(of: quota) == .quota(.review))

        // An open enum: a shape this build has never heard of must degrade, not crash.
        let future = BlockReason(shape: .init(value2: "telepathy"), options: [], tail: [])
        #expect(NotificationCopy.blockShape(of: future) == .generic)
    }

    @Test func everyKindHasAStableIdAndACategory() {
        let kinds: [NotificationKind] = [
            .done, .blocked, .ready, .mergeError, .rebaseCap, .manualSteps, .usageLimit,
        ]
        #expect(Set(kinds.map(\.id)).count == kinds.count)
        // KIND_CATEGORY in src/push.ts: done/blocked/ready/usage_limit are "agent";
        // merge_attention and manual_steps are "ci".
        #expect(NotificationKind.done.category == .agent)
        #expect(NotificationKind.blocked.category == .agent)
        #expect(NotificationKind.ready.category == .agent)
        #expect(NotificationKind.usageLimit.category == .agent)
        #expect(NotificationKind.mergeError.category == .ci)
        #expect(NotificationKind.rebaseCap.category == .ci)
        #expect(NotificationKind.manualSteps.category == .ci)
    }

    @Test func theCooldownKeyAndThreadMatchTheWebsTagging() {
        // cooldownKey = `${kind}:${sessionId}` (PushService.notify); the merge kinds key by the
        // affected session so two sessions in one repo never collapse into one banner.
        #expect(intent(.done).cooldownKey == "done:s1")
        #expect(intent(.mergeError).cooldownKey == "merge_error:s1")
        #expect(intent(.usageLimit, sessionID: nil).cooldownKey == "usage_limit:5h")
        #expect(intent(.done).threadIdentifier == "s1")
        #expect(intent(.usageLimit, sessionID: nil).threadIdentifier == "usage-5h")
    }

    /// The host-global suffix is the kind's, not a fixed `":5h"`. The web has two host-global
    /// keys and keeps them apart (`usage_limit:5h` and `usage_limit:credits` in `src/push.ts`),
    /// so a kind that arrives without a session id must not land in the 5-hour window's bucket
    /// and silence the usage warning for two minutes — or be silenced by it.
    @Test func aHostGlobalIntentDoesNotShareTheUsageWindowsKey() {
        let usage = intent(.usageLimit, sessionID: nil).cooldownKey
        #expect(usage == "usage_limit:5h")
        for kind in [NotificationKind.done, .blocked, .ready, .mergeError, .rebaseCap,
            .manualSteps]
        {
            let key = intent(kind, sessionID: nil).cooldownKey
            #expect(key != usage)
            #expect(
                !key.hasSuffix(":5h"),
                "only the usage warning's own window may be keyed on the 5-hour reset")
        }
    }
}
}
