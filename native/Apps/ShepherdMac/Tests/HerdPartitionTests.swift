import Testing
import ShepherdKit

@testable import Shepherd

/// Every rule here is the web UI's, quoted at the assertion that mirrors it. The derivation is
/// pure, so the whole sidebar contract is checked without rendering a single view.
@MainActor
struct HerdPartitionTests {
    private let now = 1_800_000_000_000
    private let noGit: (Session) -> HerdStage? = { _ in nil }

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
        func shown(_ wb: [String: Bool], _ git: @escaping (Session) -> HerdStage?) -> [String] {
            HerdPartition.shown(
                sessions, lens: .ready, workingBlocked: wb, now: now, gitStage: git
            ).map(\.id)
        }
        #expect(shown([:], noGit) == ["idle", "blocked"])
        #expect(shown(["blocked": true], noGit) == ["idle"])
        #expect(shown([:], { _ in .waitingOnReviewer }).isEmpty)
        #expect(shown([:], { _ in .ciFailed }).count == 2, "ciFailed is yours to act on")
    }

    /// `herd-partition.ts:108-110` — "Owed + Up Next are panel-only lenses (a dedicated panel, no
    /// session list)", and every other lens falls through to the full set.
    @Test func allPassesThroughAndThePanelLensesShowNothing() {
        let sessions = [session("a"), session("b", status: SessionStatus(known: .idle))]
        #expect(
            HerdPartition.shown(
                sessions, lens: .all, workingBlocked: [:], now: now, gitStage: noGit
            ).count == 2)
        for lens in [HerdLens.next, .owed] {
            #expect(
                HerdPartition.shown(
                    sessions, lens: lens, workingBlocked: [:], now: now, gitStage: noGit
                ).isEmpty,
                "\(lens) renders a panel, not a session list")
        }
    }

    /// `merge-train.ts:11-17` (`MERGE_MARK_BACKSTOP_MS = 24 * 60 * 60_000`, `isMerging`) and
    /// `herd-partition.ts:123-134` — the first-match precedence "merged > merging > … > ready",
    /// so the git classifier outranks both git-free stages.
    @Test func stagesAreMergingThenReadyThenActiveAndTheGitHookWins() {
        #expect(HerdPartition.isMerging(session("a", mergingSince: now - 1_000), now: now))
        #expect(
            !HerdPartition.isMerging(
                session("b", mergingSince: now - 25 * 60 * 60 * 1_000), now: now))
        #expect(!HerdPartition.isMerging(session("c"), now: now))
        #expect(
            HerdPartition.stageOf(
                session("d", ready: true, mergingSince: now - 1_000), now: now, gitStage: noGit
            ) == .merging)
        #expect(HerdPartition.stageOf(session("e", ready: true), now: now, gitStage: noGit) == .ready)
        #expect(HerdPartition.stageOf(session("f"), now: now, gitStage: noGit) == .active)
        #expect(
            HerdPartition.stageOf(session("g", ready: true), now: now, gitStage: { _ in .merged })
                == .merged)
    }

    /// `herd-partition.ts:190-205` (`STAGE_ORDER`) — "The canonical top→bottom lifecycle stage
    /// order of Herd.svelte's template (active first, merged last)". Empty groups are not rendered.
    @Test func groupsFollowTheWebRenderOrderAndDropEmpties() {
        let groups = HerdPartition.groups(
            [
                session("ready", ready: true),
                session("active"),
                session("merging", mergingSince: now - 1_000),
            ], now: now, gitStage: noGit)
        #expect(groups.map(\.stage) == [.active, .ready, .merging])
        #expect(groups.allSatisfy { !$0.sessions.isEmpty })
    }

    /// `HerdStage.allCases` is `STAGE_ORDER` (`herd-partition.ts:190-205`), all fourteen of it, and
    /// the web renders the active bucket without a group heading.
    @Test func everyStageHasAHeadingExceptActive() {
        #expect(HerdStage.allCases.count == 14)
        for stage in HerdStage.allCases {
            if stage == .active {
                #expect(stage.headingKey == nil, "the active group is headerless in the web UI")
            } else {
                #expect(stage.headingKey != nil, "\(stage) has no heading key")
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
                == Tallies(active: 1, idle: 1, blocked: 1, total: 4))
        #expect(
            HerdPartition.tallies(sessions, workingBlocked: ["c": true])
                == Tallies(active: 2, idle: 1, blocked: 0, total: 4))
    }

    /// `Herd.svelte:271-274` — `b?.reason.shape === "quota" ? (b.reason.quotaKind ?? null) : null`
    /// — and `UnitRowRight.svelte:226`, `{#if quotaKind && quotaKind !== "plan"}`: the `plan` kind
    /// is the plan-gate badge's, not the quota chip's.
    @Test func quotaKindOnlyForQuotaShapesAndNeverForPlan() {
        func block(
            _ shape: BlockReason.ShapePayload.Value1Payload,
            _ kind: BlockReason.QuotaKindPayload.Value1Payload?
        ) -> BlockReason {
            BlockReason(
                shape: .init(value1: shape), options: [], tail: [],
                quotaKind: kind.map { .init(value1: $0) })
        }
        #expect(HerdPartition.quotaKind(block(.quota, .rework)) == "rework")
        #expect(HerdPartition.quotaKind(block(.quota, .review)) == "review")
        #expect(HerdPartition.quotaKind(block(.quota, .plan)) == nil)
        #expect(HerdPartition.quotaKind(block(.stall, nil)) == nil)
        #expect(HerdPartition.quotaKind(nil) == nil)
    }
}
