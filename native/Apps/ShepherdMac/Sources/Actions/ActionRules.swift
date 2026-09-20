import Foundation
import ShepherdKit
import SwiftUI

/// A chord the action bar binds. Separate from SwiftUI's `KeyboardShortcut` so the set can be
/// asserted for collisions without hosting a view.
struct ActionShortcut: Equatable, Sendable {
    let key: Character
    let modifiers: EventModifiers
}

/// One per-session command the bar offers.
///
/// The set is the subset of the web's `CardMenu.svelte` whose route this stream owns. Merge PR
/// (S2), the variant/continue pickers, the cross-repo relaunch composer, the clean-terminal
/// create and Decommission (already in `MainWindow`'s toolbar) are deliberately absent — see the
/// plan's "Deliberate deviations".
enum SessionAction: String, Identifiable, CaseIterable, Sendable {
    case stop
    case resume
    case rename
    case amend
    case toggleReady
    case regenerateRecap
    case relaunch

    /// Stable id, also the accessibility identifier suffix. Kebab-case so it reads in a test
    /// failure the same way it reads in Accessibility Inspector.
    var id: String {
        switch self {
        case .stop: "stop"
        case .resume: "resume"
        case .rename: "rename"
        case .amend: "amend"
        case .toggleReady: "toggle-ready"
        case .regenerateRecap: "regenerate-recap"
        case .relaunch: "relaunch"
        }
    }

    var systemImage: String {
        switch self {
        case .stop: "stop.circle"
        case .resume: "play.circle"
        case .rename: "pencil"
        case .amend: "plus.bubble"
        case .toggleReady: "checkmark.seal"
        case .regenerateRecap: "text.badge.star"
        case .relaunch: "arrow.triangle.2.circlepath"
        }
    }

    /// Destructive actions go behind a `confirmationDialog`, never a bare click. The web arms
    /// Relaunch in two steps for the same reason; a dialog says what is lost, which a label swap
    /// cannot.
    var isDestructive: Bool { self == .relaunch }

    /// Window-scoped chords, bound on the bar's own buttons. `nil` for the destructive action:
    /// a chord that discards a worktree is a chord somebody hits by accident.
    ///
    /// The app's main menu lives on the `Scene` in `ShepherdApp.swift`, which this stream must
    /// not edit, so there are no `CommandGroup` entries. A button in the view hierarchy carries
    /// its shortcut for the whole key window, which is exactly the scope a per-session action
    /// wants.
    var shortcut: ActionShortcut? {
        switch self {
        case .stop: ActionShortcut(key: ".", modifiers: .command)
        case .resume: ActionShortcut(key: "r", modifiers: .command)
        case .rename: ActionShortcut(key: "r", modifiers: [.command, .shift])
        case .amend: ActionShortcut(key: "a", modifiers: [.command, .shift])
        case .toggleReady: ActionShortcut(key: "m", modifiers: [.command, .shift])
        case .regenerateRecap: ActionShortcut(key: "e", modifiers: [.command, .shift])
        case .relaunch: nil
        }
    }

    /// Web copy, reused verbatim. The ready toggle is the only label that depends on state.
    func label(for session: Session) -> String {
        switch self {
        case .stop: L.t("cardmenu_stop")
        case .resume: L.t("cardmenu_resume")
        case .rename: L.t("cardmenu_rename")
        case .amend: L.t("cardmenu_amend")
        case .toggleReady:
            session.readyToMerge ? L.t("gitrail_ready") : L.t("native_actions_ready_off")
        case .regenerateRecap: L.t("recap_regenerate")
        case .relaunch: L.t("cardmenu_relaunch")
        }
    }

    /// Tooltip / accessibility hint.
    func help(for session: Session) -> String {
        switch self {
        case .stop: L.t("cardmenu_stop_title")
        case .resume: L.t("cardmenu_resume")
        case .rename: L.t("viewport_rename_aria")
        case .amend: L.t("cardmenu_amend")
        case .toggleReady:
            session.readyToMerge ? L.t("gitrail_ready_on_title") : L.t("gitrail_ready_off_title")
        case .regenerateRecap: L.t("recap_regenerate")
        case .relaunch: L.t("native_actions_relaunch_confirm_title")
        }
    }
}

/// Which actions a session may receive right now.
///
/// Pure and UI-free, so every visibility decision the bar makes is assertable without hosting a
/// view — and so the port of each web predicate can be pinned one test at a time.
///
/// Two inputs belong to other streams and default to "unknown": `workingBlocked` (S3's
/// `GET /api/working-blocked`) and `gitMerged` (S2's `GET /api/sessions/{id}/git`). Both default
/// to the conservative answer, and `ActionsModel` exposes them as assignable seams the
/// integration lane fills once those streams land.
enum ActionRules {
    /// `MERGE_MARK_BACKSTOP_MS` from `ui/src/lib/components/merge-train.ts` and
    /// `src/attention-core.ts` — 24 hours. A merge mark older than this is stale.
    static let mergeMarkBackstop = 24 * 60 * 60_000

    /// `displayStatus(s, workingBlocked)` from `ui/src/lib/display-status.ts`: a `blocked`
    /// session the poller found still producing output reads as `running`. `nil` for a status
    /// this build has never heard of — an open enum, so that is a real case.
    static func displayStatus(
        _ session: Session, workingBlocked: [String: Bool] = [:]
    ) -> SessionStatusKnown? {
        if session.status.known == .blocked, workingBlocked[session.id] == true { return .running }
        return session.status.known
    }

    /// `isMerging(s, now)` from `ui/src/lib/components/merge-train.ts`.
    static func isMerging(_ session: Session, now: Int) -> Bool {
        guard let since = session.mergingSince else { return false }
        return now - since < mergeMarkBackstop
    }

    static func allows(
        _ action: SessionAction,
        session: Session,
        workingBlocked: [String: Bool] = [:],
        gitMerged: Bool = false,
        now: Int
    ) -> Bool {
        // Nothing acts on an archived session: its worktree is gone and its row is only history.
        guard session.status.known != .archived else { return false }
        let display = displayStatus(session, workingBlocked: workingBlocked)
        // `terminal` is optional on the wire (a session predating the field, or one the server
        // has not yet classified); absent reads as "not a terminal", the same conservative
        // default as every other missing signal here.
        let isTerminal = session.terminal == true

        switch action {
        case .stop:
            return display == .running && !isTerminal
        case .resume:
            guard !isTerminal else { return false }
            let isCodex = session.agentProvider?.rawValue == "codex"
            let hasConversation = isCodex || !session.claudeSessionId.isEmpty
            return hasConversation && (session.status.known == .idle || session.status.known == .done)
        case .rename, .amend, .regenerateRecap:
            return true
        case .toggleReady:
            // `readyToggleShown` in ui/src/lib/components/RailStatusActions.svelte:
            // `(git.state === "open" || ready) && status !== "running" && status !== "blocked"`.
            // Marking work ready while the agent is still moving marks a moving target, so the
            // toggle goes away until the session settles. It reads the RAW status, not the
            // display status: a `blocked` session `workingBlocked` promotes to "running" for
            // display is hidden either way, which is why this one predicate does not go through
            // `displayStatus`.
            //
            // The `git.state === "open"` half is an S2 parity gap: the git snapshot belongs to
            // that stream, and until it lands the toggle is offered for a settled session with
            // no PR too — the same conservative default the other cross-stream seams take.
            guard !isTerminal else { return false }
            return session.status.known != .running && session.status.known != .blocked
        case .relaunch:
            guard !isTerminal else { return false }
            guard !session.readyToMerge, !session.autopilotComplete else { return false }
            guard !gitMerged else { return false }
            return !isMerging(session, now: now)
        }
    }

    /// The bar's order: the state-changing verbs first, the destructive one last, matching the
    /// web menu's top-to-bottom reading order.
    static let order: [SessionAction] = [
        .stop, .resume, .rename, .amend, .toggleReady, .regenerateRecap, .relaunch,
    ]

    static func available(
        for session: Session,
        workingBlocked: [String: Bool] = [:],
        gitMerged: Bool = false,
        now: Int
    ) -> [SessionAction] {
        order.filter {
            allows($0, session: session, workingBlocked: workingBlocked, gitMerged: gitMerged, now: now)
        }
    }
}
