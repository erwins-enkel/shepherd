import Foundation
import ShepherdKit

/// The five lenses of the web's lens strip (`HerdFilter`,
/// `ui/src/lib/components/herd-partition.ts:67`). `next` and `owed` render separate panels, so
/// `shown` returns nothing for them — as the web does — and this build disables their buttons.
enum HerdLens: String, CaseIterable, Sendable {
    case next, all, ready, done, owed

    var labelKey: StaticString {
        switch self {
        case .next: "herd_seg_next"
        case .all: "herd_seg_all"
        case .ready: "herd_seg_ready"
        case .done: "herd_seg_done"
        case .owed: "herd_seg_owed"
        }
    }

    var titleKey: StaticString {
        switch self {
        case .next: "herd_next_title"
        case .all: "herd_all_title"
        case .ready: "herd_ready_title"
        case .done: "herd_done_title"
        case .owed: "herd_owed_title"
        }
    }

    /// The web's glyphs (`ui/src/lib/components/herd/lens-glyphs.ts:8-14`), the single source the
    /// lens strip and the command bar share.
    var glyph: String {
        switch self {
        case .next: "↑"
        case .all: "▦"
        case .ready: "▤"
        case .done: "✓"
        case .owed: "☑"
        }
    }

    var isAvailable: Bool { self == .all || self == .ready || self == .done }
}

/// The fourteen lifecycle stages of `stageOf` (`herd-partition.ts:48-62, 116-183`), declared in
/// the web's render order (`STAGE_ORDER`, `:190-205`). Nine are decided by per-session git state,
/// which stream S2 owns; until its classifier is injected they stay empty.
enum HerdStage: String, CaseIterable, Sendable {
    case active, ciRunning, ciFailed, reviewerRunning, reworkRunning, needsRework
    case branchProtectionBlocked, waitingOnReviewer, waitingOnMerger, draftAwaitingSignoff
    case awaitingMerge, ready, merging, merged

    /// `nil` for `active`: the web renders that group headerless.
    var headingKey: StaticString? {
        switch self {
        case .active: nil
        case .ciRunning: "herd_ci_running_group"
        case .ciFailed: "herd_ci_failed_group"
        case .reviewerRunning: "herd_reviewer_running_group"
        case .reworkRunning: "herd_rework_running_group"
        case .needsRework: "herd_changes_requested_group"
        case .branchProtectionBlocked: "herd_merge_blocked_group"
        case .waitingOnReviewer: "herd_waiting_reviewer_group_multi"
        case .waitingOnMerger: "herd_waiting_merger_group_multi"
        case .draftAwaitingSignoff: "herd_draft_awaiting_signoff_group"
        case .awaitingMerge: "herd_awaiting_merge_group"
        case .ready: "herd_ready_group"
        case .merging: "herd_merging_group"
        case .merged: "herd_merged_group"
        }
    }
}

struct RepoChip: Identifiable, Equatable, Sendable {
    let path: String
    let name: String
    let count: Int
    var id: String { path }
}

struct HerdGroup: Identifiable, Equatable, Sendable {
    let stage: HerdStage
    let sessions: [Session]
    var id: String { stage.rawValue }
}

struct Tallies: Equatable, Sendable {
    let active: Int
    let idle: Int
    let blocked: Int
    let total: Int
}

/// Every list decision the sidebar makes, with no SwiftUI and no I/O, so all of it is unit-tested
/// against the web UI's own rules instead of eyeballed in a running app.
enum HerdPartition {
    /// The web's merge window (`MERGE_MARK_BACKSTOP_MS`,
    /// `ui/src/lib/components/merge-train.ts:11`).
    static let mergingWindowMs = 24 * 60 * 60 * 1_000

    /// `ui/src/lib/display-status.ts:11-16`: a session the poller called blocked but which is still
    /// producing output reads as running. Nothing else is repainted.
    static func displayStatus(_ session: Session, workingBlocked: [String: Bool]) -> SessionStatus {
        guard session.status.known == .blocked, workingBlocked[session.id] == true else {
            return session.status
        }
        return SessionStatus(known: .running)
    }

    /// `repoChipRows` (`ui/src/lib/components/queue-strip.ts:47-77`). Archived sessions make no
    /// chip; the count is the repo's live session count; sorted by path so the rail does not jump
    /// around.
    static func repoChips(_ sessions: [Session]) -> [RepoChip] {
        var counts: [String: Int] = [:]
        for session in sessions where session.status.known != .archived {
            counts[session.repoPath, default: 0] += 1
        }
        return counts.keys.sorted().map {
            RepoChip(path: $0, name: ($0 as NSString).lastPathComponent, count: counts[$0] ?? 0)
        }
    }

    /// An empty selection means "no repo filter", like the web's `EMPTY_REPO_FILTER`
    /// (`queue-strip.ts:80-82`).
    static func filter(_ sessions: [Session], repos: Set<String>) -> [Session] {
        repos.isEmpty ? sessions : sessions.filter { repos.contains($0.repoPath) }
    }

    /// `NOT_YOUR_TURN` (`herd-partition.ts:76-81`). `ciFailed` and `draftAwaitingSignoff` are
    /// deliberately absent: both are yours to act on.
    private static let notYourTurn: Set<HerdStage> = [
        .ciRunning, .waitingOnReviewer, .waitingOnMerger, .merging,
    ]

    /// `shownSessions` (`herd-partition.ts:93-111`).
    static func shown(
        _ sessions: [Session], lens: HerdLens, workingBlocked: [String: Bool], now: Int,
        gitStage: (Session) -> HerdStage?
    ) -> [Session] {
        switch lens {
        case .next, .owed: return []
        case .all, .done: return sessions
        case .ready:
            return sessions.filter { session in
                guard displayStatus(session, workingBlocked: workingBlocked).known != .running
                else { return false }
                return !notYourTurn.contains(stageOf(session, now: now, gitStage: gitStage))
            }
        }
    }

    /// `isMerging` (`merge-train.ts:15-17`).
    static func isMerging(_ session: Session, now: Int) -> Bool {
        guard let since = session.mergingSince else { return false }
        return now - since < mergingWindowMs
    }

    /// `gitStage` is stream S2's classifier: it returns the stage for any git-decided case —
    /// including `ready`, which sits between them in the web's precedence — or `nil` when none
    /// applies. It is consulted first; the three git-free stages fill in behind it.
    static func stageOf(
        _ session: Session, now: Int, gitStage: (Session) -> HerdStage?
    ) -> HerdStage {
        if let stage = gitStage(session) { return stage }
        if isMerging(session, now: now) { return .merging }
        if session.readyToMerge { return .ready }
        return .active
    }

    /// Groups in `HerdStage`'s declaration order, which is the web's `STAGE_ORDER`; empties dropped.
    static func groups(
        _ sessions: [Session], now: Int, gitStage: (Session) -> HerdStage?
    ) -> [HerdGroup] {
        var buckets: [HerdStage: [Session]] = [:]
        for session in sessions {
            buckets[stageOf(session, now: now, gitStage: gitStage), default: []].append(session)
        }
        return HerdStage.allCases.compactMap { stage in
            guard let rows = buckets[stage], !rows.isEmpty else { return nil }
            return HerdGroup(stage: stage, sessions: rows)
        }
    }

    /// `TopBar.svelte:51, 162-164, 286-289`. Only three of the five statuses get a tally, so the
    /// three never have to add up to `total` — a done session counts only in the total.
    static func tallies(_ sessions: [Session], workingBlocked: [String: Bool]) -> Tallies {
        var active = 0
        var idle = 0
        var blocked = 0
        for session in sessions {
            switch displayStatus(session, workingBlocked: workingBlocked).known {
            case .running: active += 1
            case .idle: idle += 1
            case .blocked: blocked += 1
            default: break
            }
        }
        return Tallies(active: active, idle: idle, blocked: blocked, total: sessions.count)
    }

    /// The quota chip (`Herd.svelte:270-274`, `unit-row/UnitRowRight.svelte:226`): only a `quota`
    /// block, and never the `plan` kind, which the plan-gate badge already shows. `shape` and
    /// `quotaKind` are INLINE open enums, so the known member lives in `value1` rather than behind
    /// `OpenEnum` — an inline schema has no name to generate a named `…Known` type from
    /// (`contracts/README.md`, "Open enums").
    static func quotaKind(_ block: BlockReason?) -> String? {
        guard let block, block.shape.value1 == .quota, let known = block.quotaKind?.value1,
            known != .plan
        else { return nil }
        return known.rawValue
    }
}
