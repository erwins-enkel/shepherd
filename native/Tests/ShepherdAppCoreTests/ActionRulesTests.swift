import Foundation
import ShepherdKit
import Testing

@testable import ShepherdAppCore

extension CoreSeamTests {
/// The web's rules, ported: `stoppable` (UnitRow.svelte), `canResume` and `canRelaunch`
/// (ui/src/lib/format.ts) and `isMerging` (ui/src/lib/components/merge-train.ts). Each test
/// names the web predicate it pins.
@MainActor
struct ActionRulesTests {
    private let now = 1_800_000_000_000

    private func session(
        id: String = "s1",
        status: SessionStatusKnown = .idle,
        claudeSessionID: String = "claude-1",
        provider: String? = nil,
        terminal: Bool = false,
        readyToMerge: Bool = false,
        autopilotComplete: Bool = false,
        mergingSince: Int? = nil
    ) -> Session {
        var s = PreviewData.session(id: id, status: SessionStatus(known: status))
        s.claudeSessionId = claudeSessionID
        s.agentProvider = provider.flatMap { AgentProvider(rawValue: $0) }
        s.terminal = terminal
        s.readyToMerge = readyToMerge
        s.autopilotComplete = autopilotComplete
        s.mergingSince = mergingSince
        return s
    }

    // stoppable = dStatus === "running" && !session.terminal
    @Test func stopFollowsTheDisplayStatus() {
        let running = session(status: .running)
        #expect(ActionRules.allows(.stop, session: running, now: now))
        #expect(!ActionRules.allows(.stop, session: session(status: .idle), now: now))
        #expect(
            !ActionRules.allows(.stop, session: session(status: .running, terminal: true), now: now),
            "a clean terminal never receives the stop ESC")

        // A blocked session the poller found still producing output reads as running.
        let blocked = session(id: "b", status: .blocked)
        #expect(!ActionRules.allows(.stop, session: blocked, now: now))
        #expect(
            ActionRules.allows(.stop, session: blocked, workingBlocked: ["b": true], now: now))
    }

    // canResume: (codex || claudeSessionId) && (idle || done) && !terminal
    @Test func resumeNeedsAConversationAndAParkedSession() {
        #expect(ActionRules.allows(.resume, session: session(status: .idle), now: now))
        #expect(ActionRules.allows(.resume, session: session(status: .done), now: now))
        #expect(!ActionRules.allows(.resume, session: session(status: .running), now: now))
        #expect(
            !ActionRules.allows(.resume, session: session(claudeSessionID: ""), now: now),
            "a claude session with no conversation id has nothing to resume")
        #expect(
            ActionRules.allows(
                .resume, session: session(claudeSessionID: "", provider: "codex"), now: now),
            "codex resumes from its own launch record, not a claude session id")
        #expect(!ActionRules.allows(.resume, session: session(terminal: true), now: now))
    }

    // canRelaunch: !terminal && !readyToMerge && !autopilotComplete && !merged && !isMerging
    @Test func relaunchIsOnlyForWorkStillInFlight() {
        #expect(ActionRules.allows(.relaunch, session: session(), now: now))
        #expect(!ActionRules.allows(.relaunch, session: session(terminal: true), now: now))
        #expect(!ActionRules.allows(.relaunch, session: session(readyToMerge: true), now: now))
        #expect(
            !ActionRules.allows(.relaunch, session: session(autopilotComplete: true), now: now))
        #expect(
            !ActionRules.allows(.relaunch, session: session(), gitMerged: true, now: now),
            "a merged PR means the work landed; relaunching would duplicate it")
        #expect(
            !ActionRules.allows(.relaunch, session: session(mergingSince: now - 1_000), now: now))
        #expect(
            ActionRules.allows(
                .relaunch,
                session: session(mergingSince: now - ActionRules.mergeMarkBackstop - 1), now: now),
            "a merge mark older than the 24h backstop is stale and does not block")
    }

    @Test func renameAmendAndRecapAreOfferedForEveryLiveSession() {
        for action in [SessionAction.rename, .amend, .regenerateRecap] {
            #expect(ActionRules.allows(action, session: session(status: .running), now: now))
            #expect(
                !ActionRules.allows(action, session: session(status: .archived), now: now),
                "\(action.id) has nothing to act on once the session is archived")
        }
    }

    @Test func theReadyToggleIsHiddenForTerminalsAndArchivedSessions() {
        #expect(ActionRules.allows(.toggleReady, session: session(), now: now))
        #expect(!ActionRules.allows(.toggleReady, session: session(terminal: true), now: now))
        #expect(!ActionRules.allows(.toggleReady, session: session(status: .archived), now: now))
    }

    // readyToggleShown (RailStatusActions.svelte): … && status !== "running" && status !== "blocked"
    @Test func theReadyToggleIsHiddenWhileTheAgentIsStillMoving() {
        #expect(!ActionRules.allows(.toggleReady, session: session(status: .running), now: now))
        #expect(!ActionRules.allows(.toggleReady, session: session(status: .blocked), now: now))
        #expect(ActionRules.allows(.toggleReady, session: session(status: .idle), now: now))
        #expect(ActionRules.allows(.toggleReady, session: session(status: .done), now: now))
    }

    /// The gate reads the raw status, which is why it does not go through `displayStatus`: a
    /// blocked session the poller found still producing output stays hidden rather than being
    /// promoted to "running" and hidden for the other reason.
    @Test func theReadyToggleIgnoresTheWorkingBlockedPromotion() {
        let blocked = session(id: "b", status: .blocked)
        #expect(
            !ActionRules.allows(
                .toggleReady, session: blocked, workingBlocked: ["b": true], now: now))
        #expect(
            ActionRules.allows(
                .toggleReady, session: session(id: "b", status: .idle),
                workingBlocked: ["b": true], now: now),
            "the promotion never applies to an idle session")
    }

    @Test func availableIsOrderedAndFiltered() {
        let ids = ActionRules.available(for: session(status: .idle), now: now).map(\.id)
        #expect(ids == ["resume", "rename", "amend", "toggle-ready", "regenerate-recap", "relaunch"])
        #expect(!ids.contains("stop"))
        #expect(ActionRules.available(for: session(status: .archived), now: now).isEmpty)
    }

    @Test func everyActionHasADistinctShortcutAndTheDestructiveOneHasNone() {
        let shortcuts = SessionAction.allCases.compactMap(\.shortcut)
        let pairs = shortcuts.map { "\($0.key)-\($0.modifiers.rawValue)" }
        #expect(Set(pairs).count == pairs.count, "two actions claim the same chord")
        #expect(SessionAction.relaunch.shortcut == nil)
        #expect(SessionAction.relaunch.isDestructive)
        #expect(!SessionAction.rename.isDestructive)
    }

    @Test func labelsAndHelpResolve() {
        let s = session()
        for action in SessionAction.allCases {
            #expect(!action.label(for: s).contains("_"), "\(action.id) label did not resolve")
            #expect(!action.help(for: s).contains("_"), "\(action.id) help did not resolve")
        }
        #expect(SessionAction.toggleReady.label(for: session(readyToMerge: true)) == L.t("gitrail_ready"))
        #expect(
            SessionAction.toggleReady.label(for: session(readyToMerge: false))
                == L.t("native_actions_ready_off"))
    }
}
}
