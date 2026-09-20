import Foundation
import ShepherdKit

/// Per-session facts one stream owns and another has to read.
///
/// The parallel streams deliberately never reference each other's types, so a stream that needs
/// a fact somebody else already reads declares a seam and defaults it to the conservative
/// answer. This is where the integration lane fills those seams: `StreamRegistrations.installAll`
/// calls `connect(_:)` right after the installs, and every reader goes through the closures here
/// rather than issuing its own request.
///
/// **No second read per session.** The connected closures answer from state another extension
/// keeps current — S3's `SidebarModel` (one `GET /api/working-blocked` plus its own event-driven
/// re-reads and reconnect refresh) and S2's `DetailModel` git cache (filled when the git tab
/// loads, kept current by `session:git` pushes). Nothing here calls the server.
///
/// Every seam defaults to the conservative answer. The plan and merge seams stay at their
/// defaults until S8 and S9 land; `connect(_:)` only wires the two existing extensions.
@MainActor
enum SessionSignals {
    /// S3's `GET /api/working-blocked` — session id to "this `blocked` session is in fact still
    /// producing output". `[:]` until `connect(_:)` runs, and whenever no activation is live.
    static var workingBlocked: @MainActor () -> [String: Bool] = { [:] }

    /// S2's git snapshot, narrowed to the one question the action bar asks: has this session's
    /// PR merged? `false` for a session whose git state nobody has read yet, which is exactly
    /// what the web does before its own snapshot arrives — Relaunch stays offered.
    static var gitMerged: @MainActor (String) -> Bool = { _ in false }

    /// S8's plan-gate model: does this session have a `question-form` block with an unanswered
    /// question? The web's `planQuestionsUnanswered` (`ui/src/lib/tab-signal.svelte.ts:36-47`),
    /// which is drift-locked against the server's twin by `test/fixtures/plan-question-parity.json`.
    ///
    /// Read by S7's row badge and by `NotificationsModel.extraAttention` — the second of the two
    /// thirds of the web's badge count the notifications stream documented as missing. `false`
    /// until S8 lands, which is the conservative answer: no phantom badge.
    static var planQuestionsUnanswered: @MainActor (String) -> Bool = { _ in false }

    /// S9's merge model: session id to the number of outstanding post-merge manual steps, from
    /// `GET /api/manual-steps/outstanding`. Only rows with `clearedAt IS NULL` appear
    /// (`src/store.ts:4084`), so a key's presence IS the "you still owe this repo a step" fact.
    ///
    /// Read by S10's `owed` lens. `[:]` until S9 lands — an empty lens is right, a wrong one is
    /// not.
    static var manualStepsOutstanding: @MainActor () -> [String: Int] = { [:] }

    /// Points the two existing seams at the extensions `StreamRegistrations` just installed.
    ///
    /// The `AppModel` is captured **weakly**: these closures live for the process, and a strong
    /// capture would keep a dropped model — and the store behind it — alive for good. They
    /// resolve the extension on every call rather than holding one, because an extension is
    /// rebuilt per activation: a captured instance would answer for the profile the operator has
    /// already left.
    static func connect(_ app: AppModel) {
        workingBlocked = { [weak app] in app?.extension(SidebarModel.self)?.workingBlocked ?? [:] }
        gitMerged = { [weak app] id in
            isMerged(app?.extension(DetailModel.self)?.git[id])
        }
    }

    /// How a cached git snapshot answers "has this PR merged?". Pure, so the mapping is
    /// assertable without an `AppModel`, a store or a server.
    ///
    /// Three shapes read as "not merged": no cache entry (nobody has opened this session's git
    /// tab), a read still in flight or failed, and a `.ready` entry whose value is `nil` — the
    /// contract's "this repo has no forge, or no PR".
    static func isMerged(_ cached: Loaded<GitState?>?) -> Bool {
        guard let git = cached?.value ?? nil else { return false }
        return git.state.known == .merged
    }

    /// Tests and previews only: back to the shipped defaults.
    static func reset() {
        workingBlocked = { [:] }
        gitMerged = { _ in false }
        planQuestionsUnanswered = { _ in false }
        manualStepsOutstanding = { [:] }
    }
}
