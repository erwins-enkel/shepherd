import Foundation
import ShepherdKit

/// Turns `/events` frames into notification intents.
///
/// A direct port of the three bridges in `src/push.ts` — `attachPush` (`session:status` = done,
/// `session:block` non-null), `attachMergePush` (`automerge:status` in an attention state) and
/// `attachUsagePush` (`usage:limits` over the warning threshold). Keeping them in one pure type
/// means the native app and the server's push can be compared case by case instead of by
/// reading two event loops.
///
/// The `ready` case is the one that is **not** a port: no bridge in `src/push.ts` subscribes to
/// `session:ready` at all. The web's `ready` push comes from `ReadyNotifier.evaluateSession`
/// (`src/ready-notify.ts:185`), a polling evaluator with a 5 s dwell and a 15 s warm-up that is
/// gated on `config.reducedPushMode` and driven by PR/CI readiness. `session:ready` is instead
/// the *manual* `readyToMerge` toggle the operator flips (`POST /api/sessions/{id}/ready`). The
/// copy is `push.ts`'s verbatim; the trigger is deliberately the manual flag — see the plan's
/// deviation 5. Do not describe this case as a port of `attachPush` in a review or a commit.
///
/// Stateful in exactly one respect: the usage warning fires once per 5-hour window. The latch is
/// **not** set by `intents(for:)` — the caller sets it through `usageWarningPosted(for:)`
/// once a banner really reached the operator, because `notify()` in `src/push.ts` returns `false`
/// (app focused, category muted, inside the cooldown) far more often than it throws, and the web
/// only writes `USAGE_WARNED_KEY` inside `.then((sent) => …)`. Latching at intent time would burn
/// the window on a banner nobody saw and silence every later frame of that same window.
///
/// Repeat `done` / `blocked` frames deliberately produce repeat intents: `attachPush` is
/// stateless too, and de-duplication is the gate's 120 s cooldown (`PushService.withinCooldown`),
/// not this type's job. Do not add a last-status map here.
struct NotificationTrigger {
    /// Milliseconds since the Unix epoch — the unit every `resetAt` in this type carries. Named
    /// so a call site reads the unit off the type, not off a comment it can skip past: an
    /// accidental seconds-based clock would make `now() < warnedUntil` true forever and silently
    /// disable the usage warning after its first confirmation.
    typealias Milliseconds = Int

    /// `USAGE_WARN_PCT` in `src/push.ts`.
    static let usageWarnPercent = 80

    /// A session id to the name the copy should use. `nil` for an id the store has not seen,
    /// which falls back to the id itself — `store.get(id)?.name ?? id` in the web.
    private let subjectFor: @MainActor (String) -> String?
    /// Milliseconds since the Unix epoch, to compare against `resetAt`. Injected so the usage
    /// latch is testable and so Task 6 can thread the one clock the whole stream shares.
    private let now: @Sendable () -> Milliseconds
    /// The `resetAt` of the 5-hour window already warned about — the in-memory twin of the web's
    /// `usageWarnedResetAt5h` setting. Warnings stay suppressed while `now() < warnedUntil`.
    private var warnedUntil: Milliseconds?

    /// - Parameter now: the wall clock, as `Milliseconds` (**milliseconds since the Unix
    ///   epoch**) — the unit of `UsageLimits.session5h.resetAt`. `src/usage-limits.ts` carries no
    ///   unit comment on `LimitWindow` itself, but every producer of a `resetAt` agrees on
    ///   milliseconds: `parseResetLabel` returns `d.getTime()`, and the synthetic anchor
    ///   `w.resetAt ?? (p ? rollForward(...) : now + period)` adds `PERIOD_MS.session5h`
    ///   (`5 * 60 * 60 * 1000`) to a millisecond `now`. `attachUsagePush` then compares the
    ///   stored marker straight against `Date.now()` (`if (now() < warned) return;`).
    ///
    ///   That comparison is a **client** clock against a **server-minted** timestamp — unlike
    ///   the web, which compares two server clocks. A Mac whose clock runs hours fast degrades
    ///   the once-per-window warning to once-per-cooldown for the rest of the window; hours slow
    ///   suppresses it into the next window. There is no cheap fix without a server-time offset.
    init(
        subjectFor: @escaping @MainActor (String) -> String?,
        now: @escaping @Sendable () -> Milliseconds = { Int(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.subjectFor = subjectFor
        self.now = now
    }

    /// The caller confirms a banner was actually posted — the port of
    /// `if (sent) store.setSetting(USAGE_WARNED_KEY, …)` in `src/push.ts`. Until this is called
    /// the window is not latched, so a warning the gate dropped is retried on the next frame.
    ///
    /// Total and self-guarding: only a `.usageLimit` intent with a non-`nil` `resetAt` can latch.
    /// The natural Task 6 call site is `trigger.usageWarningPosted(for: intent)` right after
    /// posting whatever intent the gate just handled — taking the whole intent, rather than a
    /// bare `resetAt: Int`, means a `.done` or `.blocked` intent passed by mistake is a no-op
    /// instead of silently latching the usage window on `0`. `@MainActor` matches
    /// `intents(for:)`'s isolation, so there is one actor for all trigger state.
    @MainActor
    mutating func usageWarningPosted(for intent: NotificationIntent) {
        guard intent.kind == .usageLimit, let resetAt = intent.resetAt else { return }
        warnedUntil = resetAt
    }

    /// Zero or one intent per frame. An array rather than an optional so a later event that
    /// deserves two (none does today) needs no signature change at every call site.
    @MainActor
    mutating func intents(for event: ServerEvent) -> [NotificationIntent] {
        switch event {
        case .sessionStatus(let payload):
            guard payload.status.known == .done else { return [] }
            return [
                NotificationIntent(
                    kind: .done, sessionID: payload.id, subject: subject(payload.id))
            ]

        case .sessionBlock(let payload):
            // A cleared block is the agent coming back, not something to interrupt anybody for.
            guard let block = payload.block else { return [] }
            return [
                NotificationIntent(
                    kind: .blocked, sessionID: payload.id, subject: subject(payload.id),
                    blockShape: NotificationCopy.blockShape(of: block))
            ]

        case .sessionReady(let payload):
            guard payload.ready else { return [] }
            return [
                NotificationIntent(
                    kind: .ready, sessionID: payload.id, subject: subject(payload.id))
            ]

        case .automergeStatus(let status):
            let kind: NotificationKind
            switch status.state {
            case "manual_steps": kind = .manualSteps
            case "merge_error": kind = .mergeError
            case "rebase_cap": kind = .rebaseCap
            default: return []
            }
            // `detail ?? repoPath` names it; `sessionId ?? repoPath` is what a click selects and
            // what the cooldown keys on, so two sessions in one repo never collapse.
            let designation = status.detail ?? status.repoPath
            let target = status.sessionId ?? status.repoPath
            return [
                NotificationIntent(kind: kind, sessionID: target, subject: designation)
            ]

        case .usageLimits(let limits):
            // `if (!session5h || session5h.pct < USAGE_WARN_PCT) return;` — the web compares the
            // raw number, so this does too. The producer already rounds (`clampPct` is
            // `Math.round` in `src/usage-limits.ts`), so rounding first would agree today and
            // silently diverge at 79.5 the day it stops. Rounding is for display only.
            guard let window = limits.session5h,
                window.pct >= Double(Self.usageWarnPercent)
            else { return [] }
            // `if (now() < warned) return;` — a wall clock, not value equality. `resetAt` can
            // move inside one window (`src/usage-limits.ts` derives a synthetic `now + period`
            // anchor that a later real scrape replaces), and the same `resetAt` re-emitted after
            // the window has genuinely elapsed must be allowed to warn again.
            if let warnedUntil, now() < warnedUntil { return [] }
            return [
                NotificationIntent(
                    kind: .usageLimit, sessionID: nil, subject: "5h",
                    pct: Self.displayPercent(window.pct), resetAt: window.resetAt)
            ]

        case .sessionNew, .sessionRenamed, .sessionArchived, .unknown:
            // Nothing the web pushes for.
            //
            // `session:recap` arrives here as `.unknown`, and S4 has since merged and declared
            // it — but it stays in this arm, because there is nothing to port. The web has no
            // recap notification: `NotifyInput.kind` in `src/push.ts` has no recap case, no
            // bridge in that file subscribes to `session:recap`, and `src/ready-notify.ts` does
            // not either. What a recap does reach is the *in-app* surfaces — the
            // "Handlungsbedarf" line (S4's `RecapLine`, the web's recap banner) and the
            // `recap-attention` signal in `src/attention-core.ts`
            // (`recap.verdict === "needs_attention"`), which feeds the attention ladder and the
            // holds projection. Neither is a push, and `deriveTabState` — the badge's reference
            // — deliberately does not read recaps at all.
            //
            // Adding a case here would therefore invent a banner the web does not have, against
            // this type's own rule that every arm is a port with a named counterpart. If the
            // operator does want one, that is a product decision about `src/push.ts` first, and
            // the native side follows it; the two `native_notify_recap_*` catalog keys the S6 PR
            // body reserved were written on the assumption that the counterpart existed, and are
            // not added.
            return []
        }
    }

    /// Whole percent for the copy. Clamped because the conversion must be total: the contract
    /// types `pct` as a bare `number` with no bounds, and `Int(_:)` traps on a Double outside
    /// `Int`'s range — a server that stopped clamping would turn a banner into a crash.
    private static func displayPercent(_ pct: Double) -> Int {
        Int(min(100, max(0, pct.rounded())))
    }

    @MainActor
    private func subject(_ id: String) -> String { subjectFor(id) ?? id }
}
