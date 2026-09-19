import Testing
import ShepherdKit

@testable import Shepherd

/// Every rule here is the web UI's, quoted at the assertion that mirrors it. The derivation is
/// pure, so the whole sidebar contract is checked without rendering a single view.
@MainActor
struct HerdPartitionTests {
    private let now = 1_800_000_000_000
    // `@MainActor`, matching `HerdPartition`'s own parameter types (Medium fix: those closures are
    // `@MainActor` now instead of the nonisolated type `SidebarModel` used to bridge into with
    // `MainActor.assumeIsolated`) — a global-actor function type is implicitly `Sendable`, so this
    // needs no separate annotation for that.
    private let noGit: @MainActor (Session) -> HerdStage? = { _ in nil }
    private let noReview: @MainActor (Session) -> Bool = { _ in false }

    private func session(
        _ id: String, repo: String = "/repos/a",
        status: SessionStatus = SessionStatus(known: .running),
        ready: Bool = false, mergingSince: Int? = nil
    ) -> Session {
        var s = PreviewData.session(id: id, status: status)
        s.repoPath = repo
        s.readyToMerge = ready
        s.mergingSince = mergingSince
        return s
    }

    /// `ui/src/lib/display-status.ts:15` — `s.status === "blocked" && workingBlocked[s.id] ?
    /// "running" : s.status`. "The flag only ever upgrades blocked — a stale entry on a
    /// non-blocked session is inert."
    @Test func workingBlockedRepaintsOnlyBlockedSessionsAsRunning() {
        let blocked = session("a", status: SessionStatus(known: .blocked))
        let idle = session("b", status: SessionStatus(known: .idle))
        #expect(HerdPartition.displayStatus(blocked, workingBlocked: ["a": true]).known == .running)
        #expect(HerdPartition.displayStatus(blocked, workingBlocked: ["a": false]).known == .blocked)
        #expect(HerdPartition.displayStatus(blocked, workingBlocked: [:]).known == .blocked)
        #expect(HerdPartition.displayStatus(idle, workingBlocked: ["b": true]).known == .idle)
    }

    /// `ui/src/lib/components/queue-strip.ts:47-77` (`repoChipRows`) — "One chip per repo that
    /// currently has ≥1 live session (any status EXCEPT "archived")… Sorted by repoPath."
    @Test func repoChipsCountLiveSessionsSortedByPath() {
        let chips = HerdPartition.repoChips([
            session("a", repo: "/repos/zulu"),
            session("b", repo: "/repos/alpha"),
            session("c", repo: "/repos/alpha"),
            session("d", repo: "/repos/gone", status: SessionStatus(known: .archived)),
        ])
        #expect(chips.map(\.path) == ["/repos/alpha", "/repos/zulu"])
        #expect(chips.first?.count == 2)
        #expect(chips.first?.name == "alpha")
    }

    /// The web sorts with `localeCompare` (`queue-strip.ts:74`), which orders `Ä` next to `A` and
    /// `repo10` after `repo9`. Swift's `<` on `String` is codepoint order and does neither.
    @Test func repoChipsSortTheWayTheWebLocaleDoes() {
        let chips = HerdPartition.repoChips([
            session("a", repo: "/repos/repo10"),
            session("b", repo: "/repos/repo9"),
            session("c", repo: "/repos/Ärger"),
            session("d", repo: "/repos/apple"),
        ])
        #expect(chips.map(\.name) == ["apple", "Ärger", "repo9", "repo10"])
    }

    /// `ui/src/lib/components/queue-strip.ts:80-82` — `EMPTY_REPO_FILTER`, "the default for every
    /// `repoFilter?: ReadonlySet<string>` prop": an empty set filters nothing.
    @Test func anEmptyRepoFilterMeansEverything() {
        let sessions = [session("a", repo: "/repos/a"), session("b", repo: "/repos/b")]
        #expect(HerdPartition.filter(sessions, repos: []).count == 2)
        #expect(HerdPartition.filter(sessions, repos: ["/repos/b"]).map(\.id) == ["b"])
    }

    /// `herd-partition.ts:101-107` (`shownSessions`, `filter === "ready"`) plus `NOT_YOUR_TURN`
    /// (`:76-81`): "`ciFailed` is NOT hidden — a failed CI run is back in your court."
    @Test func theReadyLensDropsRunningAndStagesWhereTheBallIsElsewhere() {
        let sessions = [
            session("run"),
            session("idle", status: SessionStatus(known: .idle)),
            session("blocked", status: SessionStatus(known: .blocked)),
        ]
        func shown(_ wb: [String: Bool], _ git: @escaping @MainActor (Session) -> HerdStage?)
            -> [String]
        {
            HerdPartition.shown(
                sessions, lens: .ready, workingBlocked: wb, now: now, gitStage: git,
                inReview: noReview
            ).map(\.id)
        }
        #expect(shown([:], noGit) == ["idle", "blocked"])
        #expect(shown(["blocked": true], noGit) == ["idle"])
        #expect(shown([:], { _ in .waitingOnReviewer }).isEmpty)
        #expect(shown([:], { _ in .ciFailed }).count == 2, "ciFailed is yours to act on")
    }

    /// `herd-partition.ts:96-101` — the Ready lens' own `!inReview(s.id)` term, which is separate
    /// from the `NOT_YOUR_TURN` stage check: `reviewerRunning` is deliberately NOT in that set, so
    /// without this term a `readyToMerge` session with a critic run in flight would still be listed
    /// as awaiting the operator. It is not: the reviewer has it.
    @Test func theReadyLensAlsoDropsSessionsWithAReviewInFlight() {
        let sessions = [
            session("reviewed", status: SessionStatus(known: .idle), ready: true),
            session("mine", status: SessionStatus(known: .idle), ready: true),
        ]
        let shown = HerdPartition.shown(
            sessions, lens: .ready, workingBlocked: [:], now: now, gitStage: noGit,
            inReview: { $0.id == "reviewed" })
        #expect(shown.map(\.id) == ["mine"])
    }

    /// `herd-partition.ts:108-110` — "Owed + Up Next are panel-only lenses (a dedicated panel, no
    /// session list)", and every other lens falls through to the full set.
    @Test func allPassesThroughAndThePanelLensesShowNothing() {
        let sessions = [session("a"), session("b", status: SessionStatus(known: .idle))]
        #expect(
            HerdPartition.shown(
                sessions, lens: .all, workingBlocked: [:], now: now, gitStage: noGit,
                inReview: noReview
            ).count == 2)
        for lens in [HerdLens.next, .owed] {
            #expect(
                HerdPartition.shown(
                    sessions, lens: lens, workingBlocked: [:], now: now, gitStage: noGit,
                    inReview: noReview
                ).isEmpty,
                "\(lens) renders a panel, not a session list")
        }
    }

    /// `merge-train.ts:11-17` (`MERGE_MARK_BACKSTOP_MS = 24 * 60 * 60_000`, `isMerging`).
    @Test func mergingIsAMarkInsideTheBackstopWindow() {
        #expect(HerdPartition.isMerging(session("a", mergingSince: now - 1_000), now: now))
        #expect(
            !HerdPartition.isMerging(
                session("b", mergingSince: now - 25 * 60 * 60 * 1_000), now: now))
        #expect(!HerdPartition.isMerging(session("c"), now: now))
    }

    /// `terminalStage` (`herd-partition.ts:116-134`) is a first-match cascade, so its ORDER is the
    /// rule, not "git wins". `readyToMerge` is checked at `:124`, above `reviewerRunning`,
    /// `reworkRunning`, `ciRunning` and `ciFailed` — a green-but-pending PR that is ready to merge
    /// renders under Ready, not under CI. Only `merged` (`:121`) and `merging` (`:122`) outrank it.
    @Test func stagePrecedenceFollowsTheWebsFirstMatchCascade() {
        func stage(_ s: Session, _ git: @escaping @MainActor (Session) -> HerdStage?) -> HerdStage {
            HerdPartition.stageOf(s, now: now, gitStage: git, inReview: noReview)
        }
        let ready = session("r", ready: true)
        #expect(stage(ready, { _ in .ciRunning }) == .ready, "ready outranks a pending CI run")
        #expect(stage(ready, { _ in .ciFailed }) == .ready)
        #expect(stage(ready, { _ in .reviewerRunning }) == .ready)
        #expect(stage(ready, { _ in .awaitingMerge }) == .ready)
        #expect(stage(ready, { _ in .needsRework }) == .needsRework, "rework outranks ready")
        #expect(stage(ready, { _ in .branchProtectionBlocked }) == .branchProtectionBlocked)
        #expect(stage(ready, { _ in .merged }) == .merged)
        #expect(
            stage(session("m", ready: true, mergingSince: now - 1_000), noGit) == .merging,
            "a live merge mark outranks ready")
        #expect(
            stage(session("n", mergingSince: now - 1_000), { _ in .ciRunning }) == .merging,
            "and outranks every stage below it too")
        #expect(
            stage(session("o", mergingSince: now - 1_000), { _ in .merged }) == .merged,
            "merged is terminal")
        #expect(stage(ready, noGit) == .ready)
        #expect(stage(session("p"), noGit) == .active, "active is the floor")
        #expect(stage(session("q"), { _ in .ciRunning }) == .ciRunning)
    }

    /// H2: `reviewerRunning` is decided by `inReview` directly, not by `gitStage` — the web's
    /// `stageOf` checks `isReviewing(s.id)` as its own cascade branch (`herd-partition.ts:127`), so
    /// a critic-run session must land in `reviewerRunning` even when `gitStage` returns `nil` for
    /// it, and not fall through to `active`.
    @Test func reviewerRunningComesFromInReviewNotFromGitStage() {
        let plain = session("a")
        #expect(
            HerdPartition.stageOf(plain, now: now, gitStage: noGit, inReview: { _ in true })
                == .reviewerRunning)
        #expect(HerdPartition.stageOf(plain, now: now, gitStage: noGit, inReview: noReview) == .active)

        // `readyToMerge` is checked earlier in the cascade (`:124` before `:127`) and still wins.
        let ready = session("b", ready: true)
        #expect(
            HerdPartition.stageOf(ready, now: now, gitStage: noGit, inReview: { _ in true })
                == .ready)

        // A stage `gitStage` ranks above `reviewerRunning` (e.g. `needsRework`) still wins too.
        #expect(
            HerdPartition.stageOf(
                plain, now: now, gitStage: { _ in .needsRework }, inReview: { _ in true })
                == .needsRework)
    }

    /// The rank is `STAGE_ORDER`-independent: `HerdStage.allCases` is the RENDER order, the
    /// cascade is the CLASSIFY order, and the two differ (active renders first but classifies
    /// last). A stage added to one without the other would tie here.
    @Test func everyStageHasItsOwnPrecedenceRank() {
        let ranks = HerdStage.allCases.map(\.precedence)
        #expect(Set(ranks).count == HerdStage.allCases.count, "two stages share a rank")
        #expect(HerdStage.merged.precedence < HerdStage.merging.precedence)
        #expect(HerdStage.merging.precedence < HerdStage.ready.precedence)
        #expect(HerdStage.ready.precedence < HerdStage.ciRunning.precedence)
        #expect(HerdStage.active.precedence == ranks.max())
    }

    /// `herd-partition.ts:190-205` (`STAGE_ORDER`) — "The canonical top→bottom lifecycle stage
    /// order of Herd.svelte's template (active first, merged last)". Empty groups are not rendered.
    @Test func groupsFollowTheWebRenderOrderAndDropEmpties() {
        let groups = HerdPartition.groups(
            [
                session("ready", ready: true),
                session("active"),
                session("merging", mergingSince: now - 1_000),
            ], now: now, gitStage: noGit, inReview: noReview)
        #expect(groups.map(\.stage) == [.active, .ready, .merging])
        #expect(groups.allSatisfy { !$0.sessions.isEmpty })
    }

    /// `HerdStage.allCases` is `STAGE_ORDER` (`herd-partition.ts:190-205`), all fourteen of it, and
    /// the web renders the active bucket without a group heading.
    @Test func everyStageHasAHeadingExceptActive() {
        #expect(HerdStage.allCases.count == 14)
        for stage in HerdStage.allCases {
            if stage == .active {
                #expect(stage.headingKey() == nil, "the active group is headerless in the web UI")
            } else {
                #expect(stage.headingKey() != nil, "\(stage) has no heading key")
            }
        }
    }

    /// `TopBar.svelte:162-164, 286-289` — "Tallies are DISPLAY: a working-while-blocked session
    /// counts as working, not blocked (displayStatus upgrades it)." Only running/idle/blocked get a
    /// tally (`TallyStatus`, `:51`), so a done session shows up in the total alone.
    @Test func talliesCountThreeOfFiveStatusesAndUseTheDisplayStatus() {
        let sessions = [
            session("a"),
            session("b", status: SessionStatus(known: .idle)),
            session("c", status: SessionStatus(known: .blocked)),
            session("d", status: SessionStatus(known: .done)),
        ]
        #expect(
            HerdPartition.tallies(sessions, workingBlocked: [:])
                == HerdTallies(active: 1, idle: 1, blocked: 1, total: 4))
        #expect(
            HerdPartition.tallies(sessions, workingBlocked: ["c": true])
                == HerdTallies(active: 2, idle: 1, blocked: 0, total: 4))
    }

    /// `Herd.svelte:271-274` — `b?.reason.shape === "quota" ? (b.reason.quotaKind ?? null) : null`
    /// — and `UnitRowRight.svelte:226`, `{#if quotaKind && quotaKind !== "plan"}`: the `plan` kind
    /// is the plan-gate badge's, not the quota chip's.
    @Test func quotaKindOnlyForQuotaShapesAndNeverForPlan() {
        #expect(HerdPartition.quotaKind(block(.quota, .rework)) == "rework")
        #expect(HerdPartition.quotaKind(block(.quota, .review)) == "review")
        #expect(HerdPartition.quotaKind(block(.quota, .plan)) == nil)
        #expect(HerdPartition.quotaKind(block(.stall, nil)) == nil)
        #expect(HerdPartition.quotaKind(nil) == nil)
    }

    private func block(
        _ shape: BlockReason.ShapePayload.Value1Payload,
        _ kind: BlockReason.QuotaKindPayload.Value1Payload?
    ) -> BlockReason {
        BlockReason(
            shape: .init(known: shape), options: [], tail: [],
            quotaKind: kind.map { .init(known: $0) })
    }

    // MARK: - Values this client has never heard of

    /// Every one of these enums is open on purpose (`Model/OpenEnum.swift`): a server that learns
    /// a new status or block shape must not break an older client. So the derivation has to treat
    /// an unknown value as "not one of mine" rather than crash, mis-bucket, or match a case.
    @Test func anUnknownBlockShapeShowsNoQuotaChip() {
        let alien = BlockReason(
            shape: .init(unknown: "wormhole"), options: [], tail: [],
            quotaKind: .init(known: .rework))
        #expect(HerdPartition.quotaKind(alien) == nil, "only a `quota` shape gets the chip")
        let alienKind = BlockReason(
            shape: .init(known: .quota), options: [], tail: [],
            quotaKind: .init(unknown: "starlight"))
        #expect(
            HerdPartition.quotaKind(alienKind) == nil,
            "an unknown kind has no chip label this build could render")
    }

    /// `TallyStatus` (`TopBar.svelte:51`) is three of the five statuses; `done` and `archived` are
    /// neither, and neither is a status this build has never seen. All of them still count toward
    /// the total, exactly as the web's `sessions.length` does.
    @Test func anUnknownStatusCountsInTheTotalOnlyAndIsNeverHidden() {
        let sessions = [
            session("known", status: SessionStatus(known: .idle)),
            session("done", status: SessionStatus(known: .done)),
            session("alien", status: SessionStatus(unknown: "hibernating")),
        ]
        #expect(
            HerdPartition.tallies(sessions, workingBlocked: [:])
                == HerdTallies(active: 0, idle: 1, blocked: 0, total: 3))
        // `displayStatus` only ever upgrades a `blocked` session, so the flag is inert here.
        #expect(
            HerdPartition.tallies(sessions, workingBlocked: ["alien": true, "done": true])
                == HerdTallies(active: 0, idle: 1, blocked: 0, total: 3))
        // The Ready lens hides `running`; an unknown status is not running, so it stays.
        #expect(
            HerdPartition.shown(
                sessions, lens: .ready, workingBlocked: [:], now: now, gitStage: noGit,
                inReview: noReview
            ).map(\.id) == ["known", "done", "alien"])
        #expect(
            HerdPartition.repoChips(sessions).first?.count == 3,
            "only `archived` is not a live session")
    }

    /// `herd_waiting_{reviewer,merger}_group` take a `{who}`; the `_multi` variants are what the
    /// web falls back to when no single name owns the handoff (`en.json:254-257`).
    @Test func theTwoWaitingHeadingsNameTheHandoffWhenThereIsOne() {
        // `StaticString` is not `Equatable`; `description` is the comparable spelling.
        func key(_ stage: HerdStage, who: String? = nil) -> String? {
            stage.headingKey(who: who)?.description
        }
        #expect(key(.waitingOnReviewer) == "herd_waiting_reviewer_group_multi")
        #expect(key(.waitingOnReviewer, who: "ada") == "herd_waiting_reviewer_group")
        #expect(key(.waitingOnMerger) == "herd_waiting_merger_group_multi")
        #expect(key(.waitingOnMerger, who: "ada") == "herd_waiting_merger_group")
        #expect(
            key(.ready, who: "ada") == "herd_ready_group",
            "every other stage's heading takes no name")
    }
}
