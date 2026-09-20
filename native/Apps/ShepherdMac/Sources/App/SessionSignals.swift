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
/// **No second read per session.** Both closures answer from state another extension is already
/// keeping current — S3's `SidebarModel` (one `GET /api/working-blocked` plus its own event-driven
/// re-reads and reconnect refresh) and S2's `DetailModel` git cache (filled when the git tab
/// loads, kept current by `session:git` pushes). Nothing here calls the server.
///
/// Both default to the conservative answer, which is also what a launch reads before
/// `connect(_:)` runs and what a still-inactive `AppModel` reads afterwards: no session is
/// working-blocked, and no PR has merged.
@MainActor
enum SessionSignals {
    /// S3's `GET /api/working-blocked` — session id to "this `blocked` session is in fact still
    /// producing output". `[:]` until `connect(_:)` runs, and whenever no activation is live.
    static var workingBlocked: @MainActor () -> [String: Bool] = { [:] }

    /// S2's git snapshot, narrowed to the one question the action bar asks: has this session's
    /// PR merged? `false` for a session whose git state nobody has read yet, which is exactly
    /// what the web does before its own snapshot arrives — Relaunch stays offered.
    static var gitMerged: @MainActor (String) -> Bool = { _ in false }

    /// Points both seams at the extensions `StreamRegistrations` just installed.
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
    }
}
