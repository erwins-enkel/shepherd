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

    /// The group heading's catalog key, or `nil` for `active`: the web renders that group
    /// headerless.
    ///
    /// `who` is the single person a handoff names (`git.handoff`, stream S2's classifier). The two
    /// waiting stages have a named and an unnamed heading in both catalogs —
    /// `herd_waiting_reviewer_group` takes `{who}` and `{count}`, `…_multi` takes `{count}` alone
    /// — and the web picks between them the same way. Every other stage ignores `who`.
    func headingKey(who: String? = nil) -> StaticString? {
        switch self {
        case .active: nil
        case .ciRunning: "herd_ci_running_group"
        case .ciFailed: "herd_ci_failed_group"
        case .reviewerRunning: "herd_reviewer_running_group"
        case .reworkRunning: "herd_rework_running_group"
        case .needsRework: "herd_changes_requested_group"
        case .branchProtectionBlocked: "herd_merge_blocked_group"
        case .waitingOnReviewer:
            who == nil ? "herd_waiting_reviewer_group_multi" : "herd_waiting_reviewer_group"
        case .waitingOnMerger:
            who == nil ? "herd_waiting_merger_group_multi" : "herd_waiting_merger_group"
        case .draftAwaitingSignoff: "herd_draft_awaiting_signoff_group"
        case .awaitingMerge: "herd_awaiting_merge_group"
        case .ready: "herd_ready_group"
        case .merging: "herd_merging_group"
        case .merged: "herd_merged_group"
        }
    }

    /// Where this stage sits in `terminalStage`'s first-match cascade
    /// (`herd-partition.ts:116-134`), lowest first. This is NOT `allCases`' order: that is the
    /// render order (`STAGE_ORDER`, active first, merged last), and the two genuinely differ —
    /// `active` renders first and classifies last. `stageOf` picks the lowest-ranked candidate,
    /// which reproduces "first match wins" without a cascade of its own.
    ///
    /// The four handoff stages are the cascade's single trailing `else` branch
    /// (`handoffStage`, `:170-176`) and are mutually exclusive, so their ranks are only ever
    /// compared against the stages above and below them, never against each other.
    var precedence: Int {
        switch self {
        case .merged: 0
        case .merging: 1
        case .needsRework: 2
        case .branchProtectionBlocked: 3
        case .ready: 4
        case .reviewerRunning: 5
        case .reworkRunning: 6
        case .ciRunning: 7
        case .ciFailed: 8
        case .draftAwaitingSignoff: 9
        case .waitingOnReviewer: 10
        case .waitingOnMerger: 11
        case .awaitingMerge: 12
        case .active: 13
        }
    }
}

struct HerdRepoChip: Identifiable, Equatable, Sendable {
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

struct HerdTallies: Equatable, Sendable {
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
    static func repoChips(_ sessions: [Session]) -> [HerdRepoChip] {
        var counts: [String: Int] = [:]
        for session in sessions where session.status.known != .archived {
            counts[session.repoPath, default: 0] += 1
        }
        // `localizedStandardCompare`, not `<`: the web sorts with `localeCompare`, which files
        // `Ärger` next to `apple` rather than after `z`, and `repo10` after `repo9` rather than
        // before it. Codepoint order would do neither, and the rail is read by a human.
        return counts.sorted { $0.key.localizedStandardCompare($1.key) == .orderedAscending }
            .map {
                HerdRepoChip(
                    path: $0.key, name: ($0.key as NSString).lastPathComponent, count: $0.value)
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
    ///
    /// `inReview` is the web's own `inReview(s.id)` — a critic run in flight for this session — and
    /// the Ready lens tests it SEPARATELY from the stage check (`:96-101`), because
    /// `reviewerRunning` is deliberately not in `NOT_YOUR_TURN`. Without it a `readyToMerge`
    /// session whose review is still running would be listed as awaiting the operator when the
    /// reviewer has it. Stream S2 owns the classifier; until then nothing is under review.
    static func shown(
        _ sessions: [Session], lens: HerdLens, workingBlocked: [String: Bool], now: Int,
        gitStage: (Session) -> HerdStage?, inReview: (Session) -> Bool
    ) -> [Session] {
        switch lens {
        case .next, .owed: return []
        case .all, .done: return sessions
        case .ready:
            return sessions.filter { session in
                guard displayStatus(session, workingBlocked: workingBlocked).known != .running,
                    !inReview(session)
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

    /// `gitStage` is stream S2's classifier: it returns the stage for any git-decided case, or
    /// `nil` when none applies.
    ///
    /// It is NOT simply consulted first. The web's `terminalStage` (`herd-partition.ts:116-134`)
    /// is one flat first-match cascade in which the two git-free checks are interleaved with the
    /// git-decided ones: `merged` then `merging` then the two rework/branch-protection stages then
    /// `readyToMerge` then `reviewerRunning`, `reworkRunning`, `ciRunning`, `ciFailed`, and the
    /// handoff stages last. So a `readyToMerge` session with CI still pending belongs under Ready,
    /// not under CI. Ranking the candidates by `precedence` and taking the lowest reproduces that
    /// cascade exactly, in whatever order the candidates happen to be produced.
    static func stageOf(
        _ session: Session, now: Int, gitStage: (Session) -> HerdStage?
    ) -> HerdStage {
        var best = HerdStage.active
        if let stage = gitStage(session), stage.precedence < best.precedence { best = stage }
        if isMerging(session, now: now), HerdStage.merging.precedence < best.precedence {
            best = .merging
        }
        if session.readyToMerge, HerdStage.ready.precedence < best.precedence { best = .ready }
        return best
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
    static func tallies(_ sessions: [Session], workingBlocked: [String: Bool]) -> HerdTallies {
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
        return HerdTallies(active: active, idle: idle, blocked: blocked, total: sessions.count)
    }

    /// The quota chip (`Herd.svelte:270-274`, `unit-row/UnitRowRight.svelte:226`): only a `quota`
    /// block, and never the `plan` kind, which the plan-gate badge already shows.
    ///
    /// `shape` and `quotaKind` are INLINE open enums — an inline schema has no name to generate a
    /// named `…Known` type from, so the generator nests `Value1Payload` instead
    /// (`contracts/README.md`, "Open enums") — but both still conform to `OpenEnum`
    /// (`Model/OpenEnum.swift:66-67`), so `known` is the spelling here as everywhere else. A value
    /// this build has never seen is `nil` and shows no chip, which is the point of the open enum.
    static func quotaKind(_ block: BlockReason?) -> String? {
        guard let block, block.shape.known == .quota, let known = block.quotaKind?.known,
            known != .plan
        else { return nil }
        return known.rawValue
    }
}
