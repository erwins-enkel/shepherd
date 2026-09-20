import Foundation
import ShepherdKit
import Testing

@testable import Shepherd

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

    @Test func theUsageBodyNamesTheResetTimeOnlyWhenItHasOne() {
        let plain = NotificationCopy.body(intent(.usageLimit, sessionID: nil, pct: 83))
        #expect(plain == L.t("native_notify_usage_body"))

        let at = NotificationCopy.body(
            intent(.usageLimit, sessionID: nil, pct: 83, resetAt: 1_800_003_600_000),
            locale: Locale(identifier: "en_US"))
        #expect(at != plain)
        #expect(at.count > plain.count, "the reset-time variant names a time the plain one does not")
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
}
