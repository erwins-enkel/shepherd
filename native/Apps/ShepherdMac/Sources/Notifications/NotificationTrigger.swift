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
/// **not** set by `intents(for:)` — the caller sets it through `usageWarningPosted(resetAt:)`
/// once a banner really reached the operator, because `notify()` in `src/push.ts` returns `false`
/// (app focused, category muted, inside the cooldown) far more often than it throws, and the web
/// only writes `USAGE_WARNED_KEY` inside `.then((sent) => …)`. Latching at intent time would burn
/// the window on a banner nobody saw and silence every later frame of that same window.
///
/// Repeat `done` / `blocked` frames deliberately produce repeat intents: `attachPush` is
/// stateless too, and de-duplication is the gate's 120 s cooldown (`PushService.withinCooldown`),
/// not this type's job. Do not add a last-status map here.
struct NotificationTrigger {
    /// `USAGE_WARN_PCT` in `src/push.ts`.
    static let usageWarnPercent = 80

    /// A session id to the name the copy should use. `nil` for an id the store has not seen,
    /// which falls back to the id itself — `store.get(id)?.name ?? id` in the web.
    private let subjectFor: @MainActor (String) -> String?
    /// Milliseconds since the Unix epoch, to compare against `resetAt`. Injected so the usage
    /// latch is testable and so Task 6 can thread the one clock the whole stream shares.
    private let now: @Sendable () -> Int
    /// The `resetAt` of the 5-hour window already warned about — the in-memory twin of the web's
    /// `usageWarnedResetAt5h` setting. Warnings stay suppressed while `now() < warnedUntil`.
    private var warnedUntil: Int?

    /// - Parameter now: the wall clock, in **milliseconds since the Unix epoch** — the unit of
    ///   `UsageLimits.session5h.resetAt`, which `src/usage-limits.ts` documents as
    ///   `resetAt: number; // ms epoch of window reset` and `attachUsagePush` compares directly
    ///   against `Date.now()` (`if (now() < warned) return;`).
    init(
        subjectFor: @escaping @MainActor (String) -> String?,
        now: @escaping @Sendable () -> Int = { Int(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.subjectFor = subjectFor
        self.now = now
    }

    /// The caller confirms a banner was actually posted — the port of
    /// `if (sent) store.setSetting(USAGE_WARNED_KEY, …)` in `src/push.ts`. Until this is called
    /// the window is not latched, so a warning the gate dropped is retried on the next frame.
    mutating func usageWarningPosted(resetAt: Int) {
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
            // Nothing the web pushes for. `session:recap` arrives here as `.unknown`; it becomes
            // a case the day S4's contract block declares it.
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
