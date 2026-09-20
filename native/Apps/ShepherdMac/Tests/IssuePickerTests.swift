import Foundation
import ShepherdKit
import Testing
@testable import Shepherd

@MainActor
@Suite struct IssuePickerTests {
    private func issue(_ number: Int = 412, labels: [String] = [], assignees: [String] = [], author: String? = "operator") -> ShepherdKit.Issue {
        ShepherdKit.Issue(number: number, title: "Rate-limit the admin route", body: "Private issue body",
              url: "https://example.test/i/\(number)", labels: labels, createdAt: 1_800_000_000_000,
              assignees: assignees, author: author)
    }
    private var unfiltered: IssueFilterState {
        IssueFilterState(hideOthers: false, hideActive: false, hideSubIssues: false, hideBlocked: false)
    }
    private func defaults() -> UserDefaults { UserDefaults(suiteName: "IssuePickerTests.\(UUID())")! }
    private func model(
        defaults: UserDefaults? = nil,
        issues: @escaping (String) async throws -> IssueListing = { _ in IssueListing(issues: []) },
        commands: @escaping (String, AgentProvider) async throws -> CommandListing = { _, _ in CommandListing(commands: []) },
        epics: @escaping (String) async throws -> EpicListing = { _ in EpicListing(epics: [], subIssues: []) }
    ) -> ComposeModel {
        ComposeModel(defaults: defaults ?? self.defaults(), repoBranches: RepoBranchModel(
            loadBranches: { _ in .init(branches: []) },
            loadStatus: { _, _ in .init(behind: 0, ahead: 0, diverged: false, hasUpstream: false, localExists: false) },
            repair: { _, branch in .init(branch: branch) }), loadIssues: issues, loadCommands: commands,
                     loadEpics: epics)
    }
    private func command(_ name: String, providers: [AgentProvider] = [.claude, .codex]) -> SlashCommand {
        SlashCommand(name: name, description: "Command", scope: .init(known: .project), providers: providers)
    }

    @Test func stagesAttributeTheFirstEmptyResult() {
        for stage in IssueFilter.Stage.allCases {
            var state = unfiltered
            let row: ShepherdKit.Issue
            switch stage {
            case .others: state.hideOthers = true; row = issue(assignees: ["other"])
            case .active: state.hideActive = true; row = issue(labels: ["shepherd:active"])
            case .subIssues: state.hideSubIssues = true; row = issue()
            case .blocked: state.hideBlocked = true; row = issue(labels: ["status/Blocked-upstream"])
            case .author: state.author = "other"; row = issue()
            case .labels: state.labels = ["bug", "urgent"]; row = issue(labels: ["bug"])
            }
            let result = IssueFilter.apply([row], viewer: "operator", epicParents: [], subIssues: [412], state: state)
            #expect(result.visible.isEmpty)
            #expect(result.emptiedBy == stage)
        }
        let empty = IssueFilter.apply([], viewer: nil, epicParents: [], subIssues: [], state: .init())
        #expect(empty.emptiedBy == nil)
        var state = IssueFilterState(); state.hideActive = true
        let result = IssueFilter.apply([issue(labels: ["shepherd:active"], assignees: ["other"])],
                                       viewer: "operator", epicParents: [], subIssues: [], state: state)
        #expect(result.emptiedBy == .others)
    }

    @Test func nilViewerFailsOpenAndEpicParentsStayVisible() {
        let rows = [issue(assignees: ["other"])]
        #expect(IssueFilter.apply(rows, viewer: nil, epicParents: [412], subIssues: [412], state: .init()).visible.count == 1)
        #expect(IssueFilter.apply([issue(labels: ["unblocked"])], viewer: nil, epicParents: [], subIssues: [], state: .init()).visible.count == 1)
        var blockedByOnly = issue(); blockedByOnly.blockedBy = [999]
        #expect(IssueFilter.apply([blockedByOnly], viewer: nil, epicParents: [], subIssues: [], state: .init()).visible.count == 1)
    }

    @Test func emittedEpicParentStaysVisibleWhenItIsAlsoASubIssue() async throws {
        let payload = Data(#"{"epics":[{"parentIssueNumber":412,"parentTitle":"Parent"}],"subIssues":[412,413]}"#.utf8)
        let listing = try JSONDecoder().decode(EpicListing.self, from: payload)
        let rows = [issue(), issue(413)]
        let m = model(issues: { _ in .init(issues: rows) }, epics: { _ in listing })
        m.repoPath = "/repo"; await m.loadSources()
        #expect(m.epicParents == [412])
        #expect(m.filteredIssues.visible.map(\.number) == [412])
        m.teardown()
    }

    @Test func filterCountAndPersistence() {
        var state = IssueFilterState()
        #expect(state.activeCount(hasViewer: true) == 3)
        #expect(state.activeCount(hasViewer: false) == 2)
        state.hideActive = true; state.author = "operator"; state.labels = ["bug", "urgent"]
        #expect(state.activeCount(hasViewer: true) == 7)
        let prefs = defaults()
        let first = model(defaults: prefs)
        first.filter = state
        let second = model(defaults: prefs)
        #expect(second.filter.hideActive)
        #expect(second.filter.author == nil)
        #expect(second.filter.labels.isEmpty)
    }

    @Test func issueTriggerUsesTextBeforeCaretIncludingUnicode() {
        let text = "🐑 fix #41 tail"
        let caret = text.range(of: " tail")!.lowerBound
        let trigger = ComposeModel.trigger(in: text, caret: caret)
        #expect(trigger?.query == "41")
        #expect(trigger?.symbol == "#")
        #expect(trigger.map { String(text[$0.range]) } == "#41")
        for value in ["C#", "##", "#41 tail", "a#41"] {
            #expect(ComposeModel.trigger(in: value, caret: value.endIndex) == nil)
        }
    }

    @Test func rawIssueSearchIgnoresPanelFiltersAndCapsAtTwenty() async {
        let rows = (410...435).map { issue($0, assignees: ["other"]) }
        let m = model(issues: { _ in IssueListing(slug: "o/r", issues: rows, viewer: "operator") })
        m.repoPath = "/repo"; await m.loadSources()
        #expect(m.filteredIssues.visible.isEmpty)
        #expect(m.issueMatches("412").map(\.number) == [412])
        #expect(m.issueMatches("ADMIN").count == 20)
    }

    @Test func commandMatchesRankPrefixesBeforeSubstringsStably() {
        let rows = [command("pre-ship"), command("SHIP-it"), command("ship"), command("unrelated")]
        #expect(ComposeModel.commandMatches(rows, query: "ship").map(\.name) == ["SHIP-it", "ship", "pre-ship"])
    }

    @Test func commandPanelSearchTrimsAndMatchesDescriptions() {
        var described = command("release")
        described.description = "Ship the changes"
        let rows = [command("pre-ship"), described, command("ship"), command("unrelated")]
        #expect(ComposeModel.commandMatches(rows, query: "  SHIP \n").map(\.name) == ["ship", "pre-ship", "release"])
        #expect(ComposeModel.commandMatches(rows, query: " \n ").map(\.name) == rows.map(\.name))
    }

    @Test func nonInsertablePluginsStayVisibleAndCannotChangeThePrompt() async {
        var plugin = command("plugin", providers: [.codex])
        plugin.kind = .init(known: .plugin)
        plugin.invocations = .init(additionalProperties: [:])
        let rows = [plugin, command("ship")]
        #expect(!ComposeModel.isInsertable(plugin))
        #expect(ComposeModel.isInsertable(rows[1]))
        let m = model(commands: { _, _ in .init(commands: rows) })
        m.repoPath = "/repo"; m.provider = .codex
        await m.loadSources()
        #expect(m.commands.map(\.name) == ["plugin", "ship"])
        #expect(ComposeModel.commandMatches(rows, query: "").map(\.name) == ["plugin", "ship"])
        m.prompt = "keep $plug text"
        let caret = m.prompt.range(of: " text")!.lowerBound
        let returned = m.pickCommand(plugin, caret: caret)
        #expect(m.prompt == "keep $plug text")
        #expect(returned == caret)
        #expect(m.provider == .codex && m.providerConstraint == nil)
    }

    @Test func attachmentSeedsOnlyAnEmptyPromptAndNeverLeaksAcrossRepos() throws {
        let m = model(); m.repoPath = "/a"
        m.pickIssue(issue())
        #expect(m.prompt == L.t("newtask_issue_prompt_template", "412", "Rate-limit the admin route"))
        #expect(!m.prompt.contains("Private issue body"))
        var request = try #require(m.createRequest(baseBranch: "main"))
        #expect(request.issueRef?.body == "Private issue body")
        #expect(request.issueRef?.number == 412)
        m.prompt = "Keep this text"; m.pickIssue(issue(413))
        #expect(m.prompt == "Keep this text")
        m.repoPath = "/b"
        #expect(m.activeIssue == nil)
        request = try #require(m.createRequest(baseBranch: "main"))
        #expect(request.issueRef == nil)
    }

    @Test func claudeHoistsButCodexReplacesInPlace() {
        let m = model(); m.repoPath = "/repo"
        m.prompt = "fix the bug /sh tail"
        let caret = m.prompt.range(of: " tail")!.lowerBound
        m.pickCommand(command("ship"), caret: caret)
        #expect(m.prompt == "/ship fix the bug  tail")
        #expect(m.provider == .claude)
        m.prompt = "fix $sh tail"
        m.pickCommand(command("ship"), caret: m.prompt.range(of: " tail")!.lowerBound)
        #expect(m.prompt == "fix $ship tail")
        #expect(m.provider == .codex)
    }

    @Test func constrainedCommandSwitchesProviderBlocksSubmitAndPrunesOnTyping() {
        let m = model(); m.repoPath = "/repo"; m.provider = .codex; m.prompt = "/sh"
        m.pickCommand(command("ship", providers: [.claude]), caret: m.prompt.endIndex)
        #expect(m.provider == .claude)
        #expect(!m.allowsProvider(.codex))
        m.provider = .codex
        #expect(m.createRequest(baseBranch: "main") == nil)
        m.prompt = "ordinary prompt"
        #expect(m.providerConstraint == nil)
        #expect(m.createRequest(baseBranch: "main") != nil)
    }

    @Test func oneLoadPerSelectionAndFailureRetainsThatReposViewer() async {
        var calls = 0
        let m = model(issues: { _ in
            calls += 1
            if calls == 1 { return IssueListing(slug: "o/r", issues: [], viewer: "operator") }
            return IssueListing(slug: "o/r", issues: [], error: "fetch_failed")
        })
        m.repoPath = "/a"; await m.loadSources(); await m.loadSources()
        #expect(calls == 1)
        #expect(m.openCount == 0)
        m.repoPath = "/b"; await m.loadSources()
        #expect(m.viewer == nil)
        m.repoPath = "/a"; await m.loadSources()
        #expect(m.viewer == "operator")
        #expect(m.openCount == nil)
        #expect(m.issuesFailed)
    }

    @Test func hidingBlockedPrunesAnUnavailableSelectedLabel() async {
        let rows = [issue(labels: ["blocked-upstream"]), issue(413, labels: ["bug"])]
        let m = model(issues: { _ in IssueListing(slug: "o/r", issues: rows) })
        m.repoPath = "/repo"; await m.loadSources()
        m.filter.hideBlocked = false
        m.filter.labels = ["blocked-upstream"]
        m.filter.hideBlocked = true
        #expect(m.filter.labels.isEmpty)
        #expect(m.filteredIssues.visible.map(\.number) == [413])
    }

    @Test func inlineTriggersLoadTheirEngineWithoutChangingThePanelEngine() async {
        let claude = command("ship", providers: [.claude])
        let codex = command("video", providers: [.codex])
        var calls: [AgentProvider] = []
        let m = model(commands: { _, engine in
            calls.append(engine)
            return CommandListing(commands: engine == .claude ? [claude] : [codex])
        })
        m.repoPath = "/repo"; await m.loadSources()
        m.prompt = "$vid"
        let codexEngine = m.commandProvider(at: m.prompt.endIndex)
        #expect(codexEngine == .codex)
        await m.loadCommands(provider: codexEngine)
        #expect(m.provider == .claude)
        #expect(m.commands(for: codexEngine).map(\.name) == ["video"])
        m.provider = .codex; m.prompt = "/sh"
        let claudeEngine = m.commandProvider(at: m.prompt.endIndex)
        #expect(claudeEngine == .claude)
        await m.loadCommands(provider: claudeEngine)
        #expect(m.commands(for: claudeEngine).map(\.name) == ["ship"])
        #expect(calls == [.claude, .codex])
    }

    @Test func lateRepoAnswerCannotOverwriteCurrentSelection() async {
        var slow: CheckedContinuation<IssueListing, Never>?
        let m = model(issues: { path in
            if path == "/slow" { return await withCheckedContinuation { slow = $0 } }
            return IssueListing(slug: "fast/repo", issues: [], viewer: "fast")
        })
        m.repoPath = "/slow"
        let old = Task { await m.loadSources() }
        while slow == nil { await Task.yield() }
        m.repoPath = "/fast"; await m.loadSources()
        slow?.resume(returning: IssueListing(slug: "slow/repo", issues: [], viewer: "slow"))
        await old.value
        #expect(m.viewer == "fast")
        #expect(m.listing?.slug == "fast/repo")
    }
}
