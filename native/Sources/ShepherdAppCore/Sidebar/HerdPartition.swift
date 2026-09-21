import Foundation
import ShepherdKit

/// Live-list lenses plus panels registered by S10 before scene construction.
/// Panel-only lenses remain disabled until their factory exists.
public enum HerdLens: String, CaseIterable, Sendable {
    case next, all, ready, done, owed

    public var labelKey: StaticString {
        switch self {
        case .next: "herd_seg_next"
        case .all: "herd_seg_all"
        case .ready: "herd_seg_ready"
        case .done: "herd_seg_done"
        case .owed: "herd_seg_owed"
        }
    }

    public var titleKey: StaticString {
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
    public var glyph: String {
        switch self {
        case .next: "↑"
        case .all: "▦"
        case .ready: "▤"
        case .done: "✓"
        case .owed: "☑"
        }
    }

    @MainActor
    public var isAvailable: Bool { self == .all || self == .ready || QueuesPanels.panel(for: self) != nil }

}

/// The fourteen lifecycle stages of `stageOf` (`herd-partition.ts:48-62, 116-183`), declared in
/// the web's render order (`STAGE_ORDER`, `:190-205`). Eleven come from stream S2: ten through
/// `stageOf`'s `gitStage` closure directly, and the eleventh, `reviewerRunning`, through the
/// model's separate `inReview` predicate — the same one the Ready lens also tests on its own
/// (`HerdPartition.shown`). Until S2's classifier and reviewer predicate are injected, all eleven
/// stay empty. `merging` (`isMerging`), `ready` (`session.readyToMerge`) and the default `active`
/// floor take no git input at all.
public enum HerdStage: String, CaseIterable, Sendable {
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
    public func headingKey(who: String? = nil) -> StaticString? {
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

public struct HerdRepoChip: Identifiable, Equatable, Sendable {
    public let path: String
    public let name: String
    public let count: Int
    public var id: String { path }
}

public struct HerdGroup: Identifiable, Equatable, Sendable {
    public let stage: HerdStage
    public let sessions: [Session]
    public var id: String { stage.rawValue }
}

public struct HerdTallies: Equatable, Sendable {
    public let active: Int
    public let idle: Int
    public let blocked: Int
    public let total: Int
}

/// Every list decision the sidebar makes, with no SwiftUI and no I/O, so all of it is unit-tested
/// against the web UI's own rules instead of eyeballed in a running app.
public enum HerdPartition {
    /// The web's merge window (`MERGE_MARK_BACKSTOP_MS`,
    /// `ui/src/lib/components/merge-train.ts:11`).
    static let mergingWindowMs = 24 * 60 * 60 * 1_000

    /// `ui/src/lib/display-status.ts:11-16`: a session the poller called blocked but which is still
    /// producing output reads as running. Nothing else is repainted.
    ///
    /// This is "the single source of truth for everything that RENDERS a status"
    /// (`display-status.ts:3-10`), and the same comment's other half is just as binding: the upgrade
    /// is **display-only**, so everything that DECIDES something — `stageOf`, the archived filter,
    /// the Ready lens' own exclusion — keeps reading the raw `session.status`. `SidebarModel.rendered`
    /// applies this to the copy it hands `SessionRow`, so the row's label and tint agree with the
    /// tallies instead of contradicting them.
    public static func displayStatus(_ session: Session, workingBlocked: [String: Bool]) -> SessionStatus {
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
    /// `done` falls through to the full set here because the web does exactly that — it is not a
    /// live-list filter at all, and the web's page renders a dedicated Done panel instead
    /// (`herd-partition.ts:64-66`). This build ships no such panel, so `HerdLens.done.isAvailable`
    /// is false and this branch is unreachable from the UI; it stays faithful to the web rather
    /// than inventing a different fallthrough for a lens that cannot be selected.
    ///
    /// `inReview` is the web's own `inReview(s.id)` — a critic run in flight for this session — and
    /// the Ready lens tests it SEPARATELY from the stage check (`:96-101`), because
    /// `reviewerRunning` is deliberately not in `NOT_YOUR_TURN`. Without it a `readyToMerge`
    /// session whose review is still running would be listed as awaiting the operator when the
    /// reviewer has it. Stream S2 owns the classifier; until then nothing is under review.
    @MainActor
    static func shown(
        _ sessions: [Session], lens: HerdLens, workingBlocked: [String: Bool], now: Int,
        gitStage: @MainActor (Session) -> HerdStage?, inReview: @MainActor (Session) -> Bool
    ) -> [Session] {
        switch lens {
        case .next, .owed: return []
        case .all, .done: return sessions
        case .ready:
            return sessions.filter { session in
                guard displayStatus(session, workingBlocked: workingBlocked).known != .running,
                    !inReview(session)
                else { return false }
                return !notYourTurn.contains(
                    stageOf(session, now: now, gitStage: gitStage, inReview: inReview))
            }
        }
    }

    /// `isMerging` (`merge-train.ts:15-17`).
    static func isMerging(_ session: Session, now: Int) -> Bool {
        guard let since = session.mergingSince else { return false }
        return now - since < mergingWindowMs
    }

    /// `gitStage` is stream S2's classifier: it returns the stage for any git-decided case, or
    /// `nil` when none applies. `inReview` is its "a critic run is in flight" predicate
    /// (`isReviewing`, `herd-partition.ts:127`), which decides `reviewerRunning` directly rather
    /// than through `gitStage` — the web's `stageOf` checks it as its own cascade branch, not as
    /// part of the git snapshot.
    ///
    /// Neither is simply consulted first. The web's `terminalStage` (`herd-partition.ts:116-134`)
    /// is one flat first-match cascade in which the git-free checks are interleaved with the
    /// git-decided ones: `merged` then `merging` then the two rework/branch-protection stages then
    /// `readyToMerge` then `reviewerRunning`, `reworkRunning`, `ciRunning`, `ciFailed`, and the
    /// handoff stages last. So a `readyToMerge` session with CI still pending belongs under Ready,
    /// not under CI, and one with a review in flight still belongs under Ready if it is also
    /// `readyToMerge` — `readyToMerge` is checked first. Ranking the candidates by `precedence` and
    /// taking the lowest reproduces that cascade exactly, in whatever order the candidates happen
    /// to be produced.
    @MainActor
    static func stageOf(
        _ session: Session, now: Int, gitStage: @MainActor (Session) -> HerdStage?,
        inReview: @MainActor (Session) -> Bool
    ) -> HerdStage {
        var best = HerdStage.active
        if let stage = gitStage(session), stage.precedence < best.precedence { best = stage }
        if isMerging(session, now: now), HerdStage.merging.precedence < best.precedence {
            best = .merging
        }
        if session.readyToMerge, HerdStage.ready.precedence < best.precedence { best = .ready }
        if inReview(session), HerdStage.reviewerRunning.precedence < best.precedence {
            best = .reviewerRunning
        }
        return best
    }

    /// Groups in `HerdStage`'s declaration order, which is the web's `STAGE_ORDER`; empties dropped.
    @MainActor
    static func groups(
        _ sessions: [Session], now: Int, gitStage: @MainActor (Session) -> HerdStage?,
        inReview: @MainActor (Session) -> Bool
    ) -> [HerdGroup] {
        var buckets: [HerdStage: [Session]] = [:]
        for session in sessions {
            buckets[
                stageOf(session, now: now, gitStage: gitStage, inReview: inReview), default: []
            ].append(session)
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
    ///
    /// Returns the typed case, not its `rawValue`, so a call site (`SessionBadges.quotaLabel`)
    /// switches on it exhaustively instead of matching against string literals.
    static func quotaKind(_ block: BlockReason?) -> BlockReason.QuotaKindPayload.Value1Payload? {
        guard let block, block.shape.known == .quota, let known = block.quotaKind?.known,
            known != .plan
        else { return nil }
        return known
    }
}
