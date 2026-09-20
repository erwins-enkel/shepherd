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
/// Stateful in exactly one respect: the usage warning fires once per 5-hour window, which the
/// web persists as a `usageWarnedResetAt5h` setting. Here it is in-memory, which is the right
/// scope — a relaunched app has no banner on screen to duplicate.
struct NotificationTrigger {
    /// `USAGE_WARN_PCT` in `src/push.ts`.
    static let usageWarnPercent = 80

    /// A session id to the name the copy should use. `nil` for an id the store has not seen,
    /// which falls back to the id itself — `store.get(id)?.name ?? id` in the web.
    private let subjectFor: @MainActor (String) -> String?
    /// The `resetAt` of the 5-hour window already warned about.
    private var warnedWindow: Int?

    init(subjectFor: @escaping @MainActor (String) -> String?) {
        self.subjectFor = subjectFor
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
            guard let window = limits.session5h,
                Int(window.pct.rounded()) >= Self.usageWarnPercent
            else { return [] }
            guard warnedWindow != window.resetAt else { return [] }
            warnedWindow = window.resetAt
            return [
                NotificationIntent(
                    kind: .usageLimit, sessionID: nil, subject: "5h",
                    pct: Int(window.pct.rounded()), resetAt: window.resetAt)
            ]

        case .sessionNew, .sessionRenamed, .sessionArchived, .unknown:
            // Nothing the web pushes for. `session:recap` arrives here as `.unknown`; it becomes
            // a case the day S4's contract block declares it.
            return []
        }
    }

    @MainActor
    private func subject(_ id: String) -> String { subjectFor(id) ?? id }
}
