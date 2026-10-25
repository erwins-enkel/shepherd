import SwiftUI
import ShepherdAppCore
import ShepherdKit

/// Up Next's default issue filter on iOS (#3022) over one or more servers. Each server keeps its
/// own setting; every write goes to all of them, so a merged list filters alike. An option the
/// servers disagree on reads as mixed until the operator picks one.
@MainActor
struct IOSUpNextFilter {
    @MainActor struct Source {
        let name: String?
        let settings: IssueFilterSettingsModel
        let snapshot: UpNextSnapshot?
        let repos: [Repo]
        var value: IssueFilterSettings? { settings.value }
    }
    enum Mark: Equatable { case on, off, mixed }

    /// Only servers that have the setting; none = no filter UI.
    let sources: [Source]
    private let summaries: [UpNextFilterSummary]
    init(_ sources: [Source]) {
        self.sources = sources.filter { $0.value != nil }
        summaries = self.sources.compactMap { UpNextFilterSummary($0.snapshot) }
    }

    /// Each server's own setting, Up Next snapshot and repos.
    static func of(_ apps: [AppModel]) -> Self {
        Self(apps.compactMap { app in
            app.extension(IssueFilterSettingsModel.self).map {
                Source(name: app.activeProfile?.name, settings: $0,
                       snapshot: app.extension(QueuesModel.self)?.upNext, repos: app.store?.repos ?? [])
            }
        })
    }

    var isAvailable: Bool { !sources.isEmpty }
    private var values: [IssueFilterSettings] { sources.compactMap(\.value) }

    private func markWhere(_ held: (IssueFilterSettings) -> Bool) -> Mark {
        let count = values.filter(held).count
        return count == 0 ? .off : count == values.count ? .on : .mixed
    }
    func mark(_ scope: IssueFilterSettings.Scope) -> Mark { markWhere { $0.scope == scope } }
    func mark(_ forks: IssueFilterSettings.Forks) -> Mark { markWhere { $0.forks == forks } }
    func mark(label: String) -> Mark { markWhere { $0.isHidden(label: label) } }

    /// The active rules of every server, each once, in rule order.
    var chips: [String] {
        var seen = Set<String>()
        return values.flatMap(UpNextFilterPresentation.chips).filter { seen.insert($0).inserted }
    }
    var count: Int { chips.count }
    var isActive: Bool { count > 0 }

    func hidden(repos: Set<String>) -> Int { summaries.reduce(0) { $0 + $1.hidden(repos: repos) } }

    /// The per-rule breakdown summed over servers; only without a repo filter, as on the Mac.
    func reasons(repos: Set<String>) -> [String] {
        guard repos.isEmpty else { return [] }
        let by = summaries.map(\.hiddenBy)
        let scope = by.reduce(0) { $0 + $1.scope }, forks = by.reduce(0) { $0 + $1.forks }
        let labels = by.reduce(0) { $0 + $1.labels }, repo = by.reduce(0) { $0 + ($1.repo ?? 0) }
        return [
            scope > 0 ? L.t("upnext_filter_empty_by_scope", String(scope)) : nil,
            forks > 0 ? L.t("upnext_filter_empty_by_forks", String(forks)) : nil,
            labels > 0 ? L.t("upnext_filter_empty_by_labels", String(labels)) : nil,
            repo > 0 ? L.t("upnext_filter_empty_by_repo", String(repo)) : nil,
        ].compactMap { $0 }
    }

    private func sum(_ counts: [Int?]) -> Int? {
        let known = counts.compactMap { $0 }
        return known.isEmpty ? nil : known.reduce(0, +)
    }
    func count(_ scope: IssueFilterSettings.Scope) -> Int? { sum(summaries.map { $0.count(scope) }) }
    func count(_ forks: IssueFilterSettings.Forks) -> Int? { sum(summaries.map { $0.count(forks) }) }

    var labelOptions: [String] {
        var byKey: [String: String] = [:]
        for source in sources {
            for label in UpNextFilterPresentation.labelOptions(source.snapshot, hidden: source.value?.hiddenLabels ?? [])
            where byKey[label.lowercased()] == nil { byKey[label.lowercased()] = label }
        }
        return byKey.values.sorted { $0.localizedCompare($1) == .orderedAscending }
    }
    var forkRepos: [String] {
        Set(sources.flatMap { UpNextFilterPresentation.forkRepos($0.snapshot) })
            .sorted { $0.localizedCompare($1) == .orderedAscending }
    }

    var error: String? { sources.lazy.compactMap(\.settings.error).first }
    func clearErrors() { sources.forEach { $0.settings.clearError() } }
    var isDefault: Bool {
        values.allSatisfy { $0.scope == IssueFilterSettings.defaults.scope && $0.forks == .all && $0.hiddenLabels.isEmpty }
    }

    @discardableResult
    func setScope(_ scope: IssueFilterSettings.Scope) -> [Task<Void, Never>] {
        sources.compactMap { $0.settings.update(.init(scope: scope)) }
    }
    @discardableResult
    func setForks(_ forks: IssueFilterSettings.Forks) -> [Task<Void, Never>] {
        sources.compactMap { $0.settings.update(.init(forks: forks)) }
    }
    /// Hides (or shows) the label on every server; one already in that state is left alone.
    @discardableResult
    func setLabel(_ label: String, hidden: Bool) -> [Task<Void, Never>] {
        sources.compactMap { source in
            guard let value = source.value, value.isHidden(label: label) != hidden else { return nil }
            return source.settings.update(.init(hiddenLabels: value.toggledLabels(label)))
        }
    }
    @discardableResult
    func reset() -> [Task<Void, Never>] { sources.compactMap { $0.settings.reset() } }
}

/// What an empty Up Next says: hidden by the default filter, or genuinely nothing.
enum IOSUpNextEmpty: Equatable {
    case filtered(hidden: Int, reasons: [String])
    case plain

    @MainActor static func choose(_ filter: IOSUpNextFilter, repos: Set<String>) -> Self {
        let hidden = filter.hidden(repos: repos)
        return hidden > 0 ? .filtered(hidden: hidden, reasons: filter.reasons(repos: repos)) : .plain
    }
}

/// The lens title with its "Filter · N" button, then the active rules and "N hidden".
struct IOSUpNextFilterHeader: View {
    let filter: IOSUpNextFilter
    let repos: Set<String>
    @Binding var open: Bool

    var body: some View {
        HStack {
            Text(verbatim: L.t(HerdLens.next.labelKey).uppercased()).sessionFont(label: true, weight: .semibold)
                .foregroundStyle(SessionListStyle.amber).accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            if filter.isAvailable {
                Button { open = true } label: {
                    Text(verbatim: L.t("native_ios_upnext_filter_button", String(filter.count)))
                        .sessionFont(label: true, weight: .semibold)
                        .foregroundStyle(filter.isActive ? SessionListStyle.amber : SessionListStyle.ink)
                        .padding(.horizontal, 10)
                        .frame(minWidth: 44, minHeight: 44)
                        .overlay {
                            RoundedRectangle(cornerRadius: 3)
                                .stroke(filter.isActive ? SessionListStyle.amber : SessionListStyle.line, lineWidth: 1)
                                .padding(.vertical, 6)
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L.t("upnext_filter_button_aria", String(filter.count)))
                .accessibilityIdentifier("queues-upnext-filter")
            }
        }
        .listRowBackground(SessionListStyle.background).listRowSeparator(.hidden)
        // On the one title row: a modifier on the whole header would repeat per List row.
        .sheet(isPresented: $open) { IOSUpNextFilterSheet(filter: filter) }
        if filter.isAvailable { chips }
        if let error = filter.error {
            Button { filter.clearErrors() } label: {
                Label(error, systemImage: "exclamationmark.triangle").sessionFont(label: true)
                    .foregroundStyle(SessionListStyle.red)
            }
            .buttonStyle(.plain)
            .listRowBackground(SessionListStyle.background)
            .accessibilityIdentifier("queues-upnext-filter-error")
        }
    }

    @ViewBuilder private var chips: some View {
        let chips = filter.chips
        let hidden = filter.hidden(repos: repos)
        if !chips.isEmpty || hidden > 0 {
            Button { open = true } label: {
                ScrollView(.horizontal) {
                    HStack(spacing: 6) {
                        ForEach(chips, id: \.self) { chip in
                            Text(verbatim: chip).padding(.horizontal, 6).padding(.vertical, 2)
                                .overlay { RoundedRectangle(cornerRadius: 2).stroke(SessionListStyle.line, lineWidth: 0.5) }
                        }
                        if hidden > 0 {
                            Text(L.t("upnext_filter_hidden_count", String(hidden))).foregroundStyle(SessionListStyle.amber)
                                .accessibilityIdentifier("queues-upnext-filter-hidden")
                        }
                    }
                    .sessionFont(label: true).foregroundStyle(SessionListStyle.ink)
                }
                .scrollIndicators(.never)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .listRowBackground(SessionListStyle.background).listRowSeparator(.hidden)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(L.t("upnext_filter_chips_aria",
                                    chips.isEmpty ? L.t("upnext_filter_standard") : chips.joined(separator: ", "),
                                    String(hidden)))
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier("queues-upnext-filter-chips")
        }
    }
}

/// Everything startable is hidden by the default filter: hidden, not done.
struct IOSUpNextFilteredEmpty: View {
    let hidden: Int
    let reasons: [String]
    let adjust: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(L.t("upnext_filter_empty_title")).sessionFont(weight: .semibold).foregroundStyle(SessionListStyle.bright)
            Text(L.t("upnext_filter_empty_body", String(hidden))).sessionFont().foregroundStyle(SessionListStyle.muted)
            ForEach(reasons, id: \.self) { reason in
                Text(verbatim: "• " + reason).sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
            }
            Button(L.t("upnext_filter_adjust"), action: adjust)
                .sessionFont(weight: .semibold).foregroundStyle(SessionListStyle.amber)
                .frame(minHeight: 44)
                .accessibilityIdentifier("queues-upnext-filtered-adjust")
        }
        .padding(.vertical, 6)
        .listRowBackground(SessionListStyle.panel)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("queues-upnext-filtered-empty")
    }
}

/// The filter sheet: every change is written at once; Done only closes it.
struct IOSUpNextFilterSheet: View {
    let filter: IOSUpNextFilter
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(IssueFilterSettings.Scope.allCases, id: \.self) { scope in
                        optionRow(scope.label, detail: scope == .mine ? scope.detail : nil,
                                  count: filter.count(scope), mark: filter.mark(scope)) { _ = filter.setScope(scope) }
                            .accessibilityIdentifier("queues-upnext-filter-scope-\(scope.rawValue)")
                    }
                } header: { Text(L.t("upnext_filter_scope_heading").uppercased()) }
                Section {
                    ForEach(IssueFilterSettings.Forks.allCases, id: \.self) { forks in
                        optionRow(forks.label, detail: forks == .own ? forks.detail : nil,
                                  count: filter.count(forks), mark: filter.mark(forks)) { _ = filter.setForks(forks) }
                            .accessibilityIdentifier("queues-upnext-filter-forks-\(forks.rawValue)")
                    }
                } header: { Text(L.t("upnext_filter_forks_heading").uppercased()) } footer: {
                    let repos = filter.forkRepos
                    if !repos.isEmpty { Text(L.t("upnext_filter_forks_repos", repos.joined(separator: ", "))) }
                }
                Section {
                    let labels = filter.labelOptions
                    if labels.isEmpty { Text(L.t("upnext_filter_labels_none")).foregroundStyle(.secondary) }
                    ForEach(labels, id: \.self) { label in
                        let mark = filter.mark(label: label)
                        Toggle(isOn: Binding(get: { mark == .on }, set: { _ = filter.setLabel(label, hidden: $0) })) {
                            Text(verbatim: label)
                            if mark == .mixed { Text(L.t("native_ios_upnext_filter_mixed")) }
                        }
                        .accessibilityLabel(L.t("upnext_filter_label_toggle_aria", label))
                        .accessibilityValue(mark == .mixed ? L.t("native_ios_upnext_filter_mixed") : "")
                        .accessibilityIdentifier("queues-upnext-filter-label-\(label)")
                    }
                } header: { Text(L.t("upnext_filter_labels_heading").uppercased()) }
                Section {
                    NavigationLink {
                        IOSRepoOverridesView(filter: filter)
                    } label: { Text(L.t("settings_repo_overrides_title")) }
                        .accessibilityIdentifier("queues-upnext-filter-overrides")
                } footer: { Text(L.t("native_ios_upnext_filter_footer")) }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(L.t("upnext_filter_reset")) { _ = filter.reset() }
                        .disabled(filter.isDefault)
                        .accessibilityIdentifier("queues-upnext-filter-reset")
                }
                ToolbarItem(placement: .principal) {
                    Text(L.t("upnext_filter_title").uppercased()).font(.headline)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(L.t("native_ios_upnext_filter_done")) { dismiss() }.fontWeight(.semibold)
                        .accessibilityIdentifier("queues-upnext-filter-done")
                }
            }
        }
        .presentationDetents([.large])
        .accessibilityIdentifier("queues-upnext-filter-sheet")
    }

    private func optionRow(_ title: String, detail: String?, count: Int?, mark: IOSUpNextFilter.Mark,
                           pick: @escaping () -> Void) -> some View {
        Button { pick() } label: {
            HStack(spacing: 10) {
                Image(systemName: mark == .on ? "checkmark" : "minus")
                    .foregroundStyle(.tint).frame(width: 18)
                    .opacity(mark == .off ? 0 : 1)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: title).foregroundStyle(.primary)
                    if let detail { Text(verbatim: detail).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                }
                Spacer(minLength: 8)
                if let count { Text(verbatim: String(count)).monospacedDigit().foregroundStyle(.secondary) }
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(mark == .on ? .isSelected : [])
        .accessibilityValue(mark == .mixed ? L.t("native_ios_upnext_filter_mixed") : "")
    }
}

/// Per-repo exceptions; each repo belongs to one server, so only that server is written.
struct IOSRepoOverridesView: View {
    let filter: IOSUpNextFilter

    var body: some View {
        List {
            Section { Text(L.t("settings_repo_overrides_summary")).font(.caption).foregroundStyle(.secondary) }
            ForEach(Array(filter.sources.enumerated()), id: \.offset) { _, source in
                Section {
                    let repos = source.repos.filter { !$0.hidden }
                    if repos.isEmpty { Text(L.t("settings_repo_overrides_none")).foregroundStyle(.secondary) }
                    ForEach(repos, id: \.path) { repo in row(repo, settings: source.settings) }
                } header: {
                    if filter.sources.count > 1, let name = source.name { Text(verbatim: name) }
                }
            }
        }
        .navigationTitle(L.t("settings_repo_overrides_title"))
        .navigationBarTitleDisplayMode(.inline)
    }

    private func row(_ repo: Repo, settings: IssueFilterSettingsModel) -> some View {
        let current = settings.override(for: repo)
        return Picker(selection: Binding(get: { current }, set: { _ = settings.setOverride($0, for: repo) })) {
            Text(L.t("settings_repo_overrides_opt_standard")).tag(nil as IssueFilterSettings.RepoOverride?)
            ForEach(IssueFilterSettings.RepoOverride.allCases, id: \.self) { Text(verbatim: $0.label).tag(Optional($0)) }
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: repo.display)
                if repo.isFork { Text(L.t("upnext_filter_tag_fork").uppercased()).font(.caption).foregroundStyle(.secondary) }
            }
        }
        .accessibilityLabel(L.t("settings_repo_overrides_select_aria", repo.display))
        .accessibilityValue(current == nil ? "" : L.t("settings_repo_overrides_differs"))
        .accessibilityIdentifier("queues-upnext-repo-override-\(repo.path)")
    }
}
