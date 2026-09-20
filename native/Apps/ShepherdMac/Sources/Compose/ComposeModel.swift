import Foundation
import Observation
import ShepherdKit

/// One presentation, one issue listing shared by the panel and the prompt's # menu.
@Observable @MainActor
final class ComposeModel {
    let repoBranches: RepoBranchModel
    var repoPath = "" {
        didSet {
            guard oldValue != repoPath else { return }
            repoBranches.selectRepo(repoPath)
            generation += 1
            listing = nil; issues = []; commandListings = [:]; commandErrors = [:]; epicParents = []; subIssues = []
            viewer = viewers[repoPath]; issuesFailed = false
            filter.author = nil; filter.labels = []; expanded = false
            loading = false
        }
    }
    var provider: AgentProvider = .claude
    var research = false
    var epicAuthoring = false
    var plain = false
    var planGateEnabled = false
    var planGateTouched = false
    var autopilotEnabled = false
    var autopilotTouched = false
    var sandboxProfile: Components.Schemas.SandboxProfile?
    private(set) var modeTouched = false
    private var designPreselected = false
    var prompt = "" {
        didSet {
            updateDesignPreselection()
            if let constraint = providerConstraint, !prompt.contains(constraint.token) {
                providerConstraint = nil
            }
        }
    }
    var filter: IssueFilterState {
        didSet {
            if filter.hideBlocked != oldValue.hideBlocked {
                filter.labels.formIntersection(Set(labels))
            }
            persistFilter()
        }
    }
    var source: SourceToggle.Source = .issues
    var expanded = false
    private(set) var listing: IssueListing?
    private(set) var issues: [Issue] = []
    private var commandListings: [AgentProvider: [SlashCommand]] = [:]
    var commands: [SlashCommand] { commands(for: provider) }
    private(set) var viewer: String?
    private(set) var epicParents: Set<Int> = []
    private(set) var subIssues: Set<Int> = []
    private(set) var loading = false
    private(set) var issuesFailed = false
    private var commandErrors: [AgentProvider: String] = [:]
    var commandsError: String? { commandErrors[provider] }
    private(set) var attached: Issue?
    private var attachedRepoPath: String?

    struct ProviderConstraint: Equatable {
        let token: String
        let provider: AgentProvider
    }
    private(set) var providerConstraint: ProviderConstraint?
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let fetchIssues: (String) async throws -> IssueListing
    @ObservationIgnored private let fetchCommands: (String, AgentProvider) async throws -> CommandListing
    @ObservationIgnored private let fetchEpics: (String) async throws -> EpicListing
    private var generation = 0
    private var loadedGeneration: Int?
    private var commandGenerations: [AgentProvider: Int] = [:]
    private var viewers: [String: String] = [:]

    convenience init(client: ShepherdClient, defaults: UserDefaults = .standard) {
        self.init(defaults: defaults, repoBranches: RepoBranchModel(client: client), loadIssues: { try await client.issues(repoPath: $0) },
                  loadCommands: { try await client.commands(repoPath: $0, provider: $1) },
                  loadEpics: { try await client.epics(repoPath: $0) })
    }

    init(defaults: UserDefaults, repoBranches: RepoBranchModel, loadIssues: @escaping (String) async throws -> IssueListing,
         loadCommands: @escaping (String, AgentProvider) async throws -> CommandListing,
         loadEpics: @escaping (String) async throws -> EpicListing) {
        self.repoBranches = repoBranches
        self.defaults = defaults
        fetchIssues = loadIssues; fetchCommands = loadCommands; fetchEpics = loadEpics
        filter = IssueFilterState(
            hideOthers: defaults.object(forKey: "shepherd:issues-hide-others") as? Bool ?? true,
            hideActive: defaults.bool(forKey: "shepherd:issues-hide-active"),
            hideSubIssues: defaults.object(forKey: "shepherd:issues-hide-subissues") as? Bool ?? true,
            hideBlocked: defaults.object(forKey: "shepherd:issues-hide-blocked") as? Bool ?? true)
    }

    /// Derived from the three wire flags; a stored enum would be a second source of truth.
    var mode: ComposeMode {
        if research { return .research }
        if epicAuthoring { return .epic }
        if plain { return .plain }
        return .code
    }

    var modeLocked: Bool { research || epicAuthoring || plain }
    var sandboxLocked: Bool { research || epicAuthoring }
    var shapingOffered: Bool { mode == .code }

    var guardExplanation: String? {
        switch mode {
        case .code: nil
        case .research: L.t("newtask_guards_none_research")
        case .epic: L.t("newtask_guards_none_epic")
        case .plain: L.t("newtask_guards_none_plain")
        }
    }

    /// Leaving Code forces both guards off and marks them touched: the wire must carry false,
    /// so a repo default cannot re-enable a plan gate on a task that has no plan.
    /// Returning to Code deliberately does not restore guards the operator never agreed to.
    func setMode(_ next: ComposeMode) {
        modeTouched = true
        research = next == .research
        epicAuthoring = next == .epic
        plain = next == .plain
        guard next != .code else { return }
        planGateEnabled = false
        planGateTouched = true
        autopilotEnabled = false
        autopilotTouched = true
        if sandboxLocked, sandboxProfile == .autonomous { sandboxProfile = nil }
    }

    /// A suggestion follows the leading command until the operator makes an explicit choice.
    /// Only plain moves here; editing the command away must preserve the Code guard preferences.
    private func updateDesignPreselection() {
        guard !modeTouched else { return }
        let wantsPlain = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
            .range(of: #"^/design(\s|$)"#, options: .regularExpression) != nil
        if wantsPlain, mode == .code {
            plain = true
            designPreselected = true
        } else if !wantsPlain, designPreselected {
            plain = false
            designPreselected = false
        }
    }

    private func persistFilter() {
        defaults.set(filter.hideOthers, forKey: "shepherd:issues-hide-others")
        defaults.set(filter.hideActive, forKey: "shepherd:issues-hide-active")
        defaults.set(filter.hideSubIssues, forKey: "shepherd:issues-hide-subissues")
        defaults.set(filter.hideBlocked, forKey: "shepherd:issues-hide-blocked")
    }

    func loadSources() async {
        guard !repoPath.isEmpty, loadedGeneration != generation else { return }
        let mine = generation, repo = repoPath
        loadedGeneration = mine
        loading = true
        async let issueLoad: Void = loadIssueListing(repo, generation: mine)
        async let epicLoad: Void = loadEpicListing(repo, generation: mine)
        async let commandLoad: Void = loadCommands()
        _ = await (issueLoad, epicLoad, commandLoad)
        if mine == generation { loading = false }
    }

    private func loadIssueListing(_ repo: String, generation mine: Int) async {
        do {
            let result = try await fetchIssues(repo)
            guard mine == generation else { return }
            listing = result; issues = result.issues; issuesFailed = result.error != nil
            // A failed fetch must not evict a viewer cached for THIS repo.
            if !issuesFailed { viewers[repo] = result.viewer; viewer = result.viewer }
        } catch {
            guard mine == generation else { return }
            issuesFailed = true
        }
    }

    private func loadEpicListing(_ repo: String, generation mine: Int) async {
        do {
            let result = try await fetchEpics(repo)
            guard mine == generation else { return }
            epicParents = Set(result.epics.map(\.parentIssueNumber)); subIssues = Set(result.subIssues)
        } catch { /* Best effort: absent epic data leaves the sub-issue filter open. */ }
    }

    func commands(for provider: AgentProvider) -> [SlashCommand] { commandListings[provider] ?? [] }

    func commandProvider(at caret: String.Index) -> AgentProvider {
        switch Self.trigger(in: prompt, caret: caret)?.symbol {
        case "/": .claude
        case "$": .codex
        default: provider
        }
    }

    /// Cache separately per engine: a $ menu may load Codex while the panel stays on Claude.
    func loadCommands(provider requestedProvider: AgentProvider? = nil) async {
        let repo = repoPath, engine = requestedProvider ?? provider, mine = generation
        guard !repo.isEmpty, commandGenerations[engine] != mine else { return }
        commandGenerations[engine] = mine
        commandErrors[engine] = nil
        do {
            let result = try await fetchCommands(repo, engine)
            guard mine == generation else { return }
            commandListings[engine] = result.commands.filter(Self.isInsertable)
        } catch {
            guard mine == generation else { return }
            commandErrors[engine] = ShepherdErrorCopy.message(error)
        }
    }

    func teardown() {
        repoBranches.teardown()
        generation += 1
    }

    func openRepoPicker() { repoBranches.presentedPicker = .repo }
    func openBranchPicker() { repoBranches.presentedPicker = .branch }
    func cycleRepo(_ direction: Int, repos: [Repo]) {
        let visible = repos.filter { !$0.hidden }
        guard !visible.isEmpty else { return }
        let next: Int
        if let index = visible.firstIndex(where: { $0.path == repoPath }) {
            next = (index + (direction < 0 ? -1 : 1) + visible.count) % visible.count
        } else {
            next = direction < 0 ? visible.count - 1 : 0
        }
        repoPath = visible[next].path
    }

    var openCount: Int? { listing?.slug != nil && !issuesFailed ? issues.count : nil }
    var activeIssue: Issue? { attachedRepoPath == repoPath ? attached : nil }
    var filteredIssues: (visible: [Issue], emptiedBy: IssueFilter.Stage?) {
        IssueFilter.apply(issues, viewer: viewer, epicParents: epicParents, subIssues: subIssues, state: filter)
    }
    var authors: [String] { Array(Set(issues.compactMap(\.author))).sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending } }
    var labels: [String] {
        Array(Set(issues.flatMap(\.labels))).filter {
            $0 != "shepherd:active" && (!filter.hideBlocked || !IssueFilter.isBlocked($0))
        }.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }

    func pickIssue(_ issue: Issue) {
        attached = issue; attachedRepoPath = repoPath
        if prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            prompt = L.t("newtask_issue_prompt_template", String(issue.number), issue.title)
        }
    }
    func removeIssue() { attached = nil; attachedRepoPath = nil }
    func pickIssueFromSearch(_ issue: Issue, caret: String.Index) {
        if let trigger = Self.trigger(in: prompt, caret: caret), trigger.symbol == "#" {
            prompt.removeSubrange(trigger.range)
        }
        pickIssue(issue)
    }
    func issueMatches(_ query: String) -> [Issue] {
        Array(issues.filter { String($0.number).hasPrefix(query) || $0.title.localizedCaseInsensitiveContains(query) || query.isEmpty }.prefix(20))
    }

    struct Trigger {
        let symbol: String
        let query: String
        let range: Range<String.Index>
    }
    static func trigger(in text: String, caret: String.Index) -> Trigger? {
        let before = String(text[..<caret])
        for pattern in [#"(^|\s)(#)([^\s#]*)$"#, #"(^|\s)([/\$])(\S*)$"#] {
            guard let regex = try? NSRegularExpression(pattern: pattern),
                  let match = regex.firstMatch(in: before, range: NSRange(before.startIndex..., in: before)),
                  let symbolRange = Range(match.range(at: 2), in: text),
                  let queryRange = Range(match.range(at: 3), in: text) else { continue }
            return Trigger(symbol: String(text[symbolRange]), query: String(text[queryRange]), range: symbolRange.lowerBound..<caret)
        }
        return nil
    }
    static func commandMatches(_ commands: [SlashCommand], query: String) -> [SlashCommand] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let insertable = commands.filter(isInsertable)
        return insertable.filter { $0.name.lowercased().hasPrefix(query) }
            + insertable.filter {
                !$0.name.lowercased().hasPrefix(query)
                    && ($0.name.lowercased().contains(query) || $0.description.lowercased().contains(query))
            }
    }

    private static func isInsertable(_ command: SlashCommand) -> Bool {
        guard let invocations = command.invocations else { return true }
        return invocations.additionalProperties.values.contains { !$0.isEmpty }
    }

    @discardableResult
    func pickCommand(_ command: SlashCommand, caret: String.Index? = nil) -> String.Index {
        let trigger = caret.flatMap { Self.trigger(in: prompt, caret: $0) }
        let providers = command.providers.flatMap { $0.isEmpty ? nil : $0 } ?? [.claude]
        let preferred: AgentProvider = trigger?.symbol == "$" ? .codex : trigger?.symbol == "/" ? .claude : provider
        let selected = providers.contains(preferred) ? preferred : providers[0]
        // An explicit map is authoritative. Plugin rows may have no invocation at all.
        if let invocations = command.invocations,
           invocations.additionalProperties[selected.rawValue]?.isEmpty != false {
            return caret ?? prompt.endIndex
        }
        provider = selected
        let name = command.invocationName ?? command.name
        let token = command.invocations?.additionalProperties[provider.rawValue] ?? (provider == .codex ? "$" : "/") + name
        let insertionOffset: Int
        if let trigger {
            let head = String(prompt[..<trigger.range.lowerBound]), tail = String(prompt[trigger.range.upperBound...])
            if provider == .claude {
                prompt = token + " " + (head + tail).trimmingCharacters(in: .whitespacesAndNewlines)
                insertionOffset = token.count + 1
            } else {
                prompt = head + token + " " + tail.drop(while: \.isWhitespace)
                insertionOffset = head.count + token.count + 1
            }
        } else {
            prompt = token + " "
            insertionOffset = prompt.count
        }
        providerConstraint = providers.count == 1 ? ProviderConstraint(token: token, provider: provider) : nil
        return prompt.index(prompt.startIndex, offsetBy: insertionOffset)
    }
    func allowsProvider(_ provider: AgentProvider) -> Bool {
        providerConstraint == nil || providerConstraint?.provider == provider
    }
    func createRequest(baseBranch: String) -> CreateSessionRequest? {
        guard !repoPath.isEmpty, !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              allowsProvider(provider) else { return nil }
        var request = CreateSessionRequest(repoPath: repoPath, baseBranch: baseBranch, prompt: prompt, agentProvider: provider)
        request.research = research
        request.epicAuthoring = epicAuthoring
        request.plain = plain
        // Automatic /design preselection leaves preferences untouched but still sends no guards.
        request.planGateEnabled = modeLocked ? false : (planGateTouched ? planGateEnabled : nil)
        request.autopilotEnabled = modeLocked ? false : (autopilotTouched ? autopilotEnabled : nil)
        request.sandboxProfile = sandboxLocked && sandboxProfile == .autonomous ? nil : sandboxProfile
        if let issue = activeIssue {
            request.issueRef = .init(number: issue.number, url: issue.url, title: issue.title, body: issue.body)
        }
        return request
    }
}
