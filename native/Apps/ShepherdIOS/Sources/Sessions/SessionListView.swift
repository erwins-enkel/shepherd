import SwiftUI
import ShepherdAppCore
import ShepherdKit

struct SessionListView: View {
    let model: SidebarModel
    let select: (String) -> Void
    @Environment(AppModel.self) private var app
    @Environment(IOSServerHub.self) private var hub: IOSServerHub?
    @State private var epicDirectory = IOSEpicDirectory()
    @State private var collapsedEpics: Set<String> = []
    @State private var refreshError: String?
    @State private var showingRepos = false
    @State private var explainingStage: HerdStage?
    @State private var explanationTitle = ""
    @Environment(\.horizontalSizeClass) private var sizeClass
    private var layout: IOSSessionListLayout { .init(sizeClass: sizeClass) }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 20)) { context in
            content(now: Int(context.date.timeIntervalSince1970 * 1_000))
        }
        .background(SessionListStyle.background)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if layout.bottomBar { bottomBar }
        }
        .sheet(isPresented: $showingRepos) { IOSServerReposSheet(model: model) }
        .sheet(isPresented: Binding(get: { explainingStage != nil }, set: { if !$0 { explainingStage = nil } })) {
            if let stage = explainingStage, let explanation = IOSSessionListPresentation.groupHelp(stage) {
                NavigationStack {
                    ScrollView {
                        Text(verbatim: explanation).sessionFont().foregroundStyle(SessionListStyle.ink)
                            .frame(maxWidth: .infinity, alignment: .leading).padding()
                    }
                    .background(SessionListStyle.background)
                    .navigationTitle(explanationTitle)
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) {
                        Button(L.t("common_close")) { explainingStage = nil }
                    } }
                }
                .presentationDetents([.medium, .large])
                .preferredColorScheme(.dark)
            }
        }
        .navigationTitle("")
        .toolbar(.hidden, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(SessionListStyle.background, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .tint(SessionListStyle.amber)
        .preferredColorScheme(.dark)
        .accessibilityIdentifier("session-list")
        .task(id: epicLoadIdentity) {
            await epicDirectory.load(presentation.epicGroups, owners: hub?.models ?? [:], fallback: app)
        }
        .onChange(of: selectionIDs) { _, _ in
            for owner in hub?.connected ?? [app] {
                owner.reconcileSelection(against: (owner.store?.sessions.map(\.id) ?? []) + (owner.extension(QueuesModel.self)?.finishedSessions.map(\.id) ?? []))
            }
        }
    }

    private var epicLoadIdentity: [String] {
        presentation.epicGroups.map { group in
            let owner = hub?.models[group.profile.id] ?? app
            return "\(group.id):\(ObjectIdentifier(owner)):\(owner.activationGeneration)"
        }
    }
    private var lens: HerdLens { hub?.lens ?? model.lens }
    private var activeRepos: Set<String> { hub == nil ? model.activeRepos : presentation.repos }
    private var collapsedStages: Set<HerdStage> { hub?.collapsedStages ?? model.collapsedStages }
    private var presentation: IOSMergedSessionPresentation.Snapshot {
        if let hub { return IOSMergedSessionPresentation.snapshot(hub) }
        let profile = app.activeProfile ?? ServerProfile(id: UUID(uuidString: "00000000-0000-0000-0000-000000000000")!, name: "", baseURL: URL(string: "https://fixture.invalid")!, mode: .remote, credentialKey: "fixture")
        return IOSMergedSessionPresentation.merge([.init(profile: profile, groups: model.groups,
            sessions: app.store?.sessions ?? model.sessions, rendered: (app.store?.sessions ?? model.sessions).map(model.rendered),
            git: herd?.git ?? [:], finished: queues?.finishedSessions ?? [], owed: merge?.snapshot.owed ?? [])], selectedRepos: model.activeRepos)
    }
    private func setLens(_ value: HerdLens) { if let hub { hub.setLens(value) } else { model.lens = value } }
    private func toggleRepo(_ path: String) { if let hub { hub.toggleRepo(path) } else { model.toggleRepo(path, additive: false) } }
    private func toggleCollapsed(_ stage: HerdStage) { if let hub { hub.toggleCollapsed(stage) } else { model.toggleCollapsed(stage) } }
    private func selectRow(_ id: IOSSessionIdentity) { if let hub { hub.select(id) } else { select(id.sessionID) } }
    private var queues: QueuesModel? { app.extension(QueuesModel.self) }
    private var herd: HerdSignals? { app.extension(HerdSignals.self) }
    private var merge: MergeModel? { app.extension(MergeModel.self) }
    private var owedCount: String {
        (hub?.connected ?? [app]).allSatisfy { $0.extension(MergeModel.self)?.settled == true && $0.extension(MergeModel.self)?.error == nil } ? String(presentation.owed.count) : "—"
    }
    private var owed: [PostMergeSteps] { presentation.owed.map(\.record) }
    private var selectionIDs: [String] {
        (hub?.connected ?? [app]).flatMap { owner in
            (owner.store?.sessions.map { "\(ObjectIdentifier(owner))-\($0.id)" } ?? []) + (owner.extension(QueuesModel.self)?.finishedSessions.map { "\(ObjectIdentifier(owner))-\($0.id)" } ?? [])
        }
    }

    private func content(now: Int) -> some View {
        let chips = presentation.chips
        let snapshot = presentation
        let groups = snapshot.groups
        let showCli = SessionBadges.showsCli(for: (snapshot.epicGroups.flatMap(\.rows) + groups.flatMap(\.rows)).map(\.session))
        return VStack(spacing: 0) {
            HStack(spacing: 10) { header; Spacer(minLength: 0); settingsMenu }
                .padding(.horizontal, 12).padding(.vertical, 5)
                .background(SessionListStyle.panel)
                .overlay(alignment: .bottom) { Rectangle().fill(SessionListStyle.brightLine).frame(height: 1) }
            if !layout.bottomBar { lensStrip }
            if layout.repoRail, (chips.count >= 2 || !activeRepos.isEmpty) { repoRail(chips) }
            if let limits = model.limits {
                let warnings = UsageMeter.bars(limits).filter { $0.pct > 50 }
                if !warnings.isEmpty {
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(warnings) { bar in
                            Label(L.t("native_ios_usage_warning", L.t(bar.nameKey), String(Int(bar.pct))), systemImage: "exclamationmark.triangle")
                                .foregroundStyle(bar.pct > 90 ? SessionListStyle.red : SessionListStyle.amber)
                        }
                    }
                    .sessionFont(label: true).padding(.horizontal, 12).padding(.vertical, 6)
                    .accessibilityIdentifier("session-usage-warning")
                }
            }
            List {
                if let refreshError { Text(verbatim: refreshError).foregroundStyle(SessionListStyle.red).sessionFont() }
                if layout.bottomBar, layout.menuLenses.contains(lens) {
                    Text(verbatim: L.t(lens.labelKey).uppercased()).sessionFont(label: true, weight: .semibold)
                        .foregroundStyle(SessionListStyle.amber).accessibilityAddTraits(.isHeader)
                        .listRowBackground(SessionListStyle.background).listRowSeparator(.hidden)
                }
                switch lens {
                case .all, .ready:
                    if groups.isEmpty, snapshot.epicGroups.isEmpty, hub?.hasLoadedList ?? (app.store?.connection == .live) {
                        empty(SidebarCopy.empty(lens: lens, repos: activeRepos))
                    }
                    ForEach(snapshot.epicGroups) { group in
                        IOSEpicGroupHeader(group: group,
                            summary: epicDirectory.summary(group, owner: hub?.models[group.profile.id] ?? app),
                            collapsed: collapsedEpics.contains(group.id)) {
                                if !collapsedEpics.insert(group.id).inserted { collapsedEpics.remove(group.id) }
                            }
                        if !collapsedEpics.contains(group.id) {
                            ForEach(group.rows) { row in card(row, showCli: showCli, now: now, leading: 22) }
                        }
                    }
                    ForEach(groups) { group in
                        if let heading = group.heading {
                            groupHeader(group.stage, title: heading)
                        }
                        if group.stage == .active || !collapsedStages.contains(group.stage) {
                            ForEach(group.rows) { row in card(row, showCli: showCli, now: now) }
                        }
                    }
                case .done:
                    let sessions = presentation.finished
                    if (hub?.connected ?? [app]).contains(where: { $0.extension(QueuesModel.self)?.isRefreshing == true }), sessions.isEmpty { ProgressView(L.t("common_loading")) }
                    else if sessions.isEmpty { empty(L.t("herd_done_empty")) }
                    ForEach(sessions) { row in card(row, showCli: SessionBadges.showsCli(for: sessions.map(\.session)), now: now) }
                case .next:
                    if let hub, hub.connected.count > 1 { IOSMergedNextRows(hub: hub, repos: activeRepos) }
                    else { IOSUpNextRows(model: queues, repos: activeRepos) }
                case .owed: IOSMergedOwedRows(rows: presentation.owed, owners: hub?.models ?? [:], fallback: app, showServers: (hub?.connected.count ?? 1) > 1, select: selectRow)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .listRowSpacing(6)
            .environment(\.defaultMinListRowHeight, 0)
            .foregroundStyle(SessionListStyle.ink)
            .refreshable { await refresh() }
        }
    }

    private func lensButton(_ lens: HerdLens, bottom: Bool) -> some View {
        SessionLensButton(lens: lens, selected: self.lens == lens, bottom: bottom,
            owedCount: owedCount, owedAccessibilityValue: owedAccessibilityValue) { setLens(lens) }
    }

    private var lensStrip: some View {
        HStack(spacing: 0) {
            ScrollView(.horizontal) {
                HStack(spacing: 0) {
                    ForEach(layout.stripLenses, id: \.self) { lensButton($0, bottom: false) }
                }
            }
            .scrollIndicators(.never)
            if app.liveRequestAudit == nil { newTaskButton(bottom: false) }
        }
        .accessibilityLabel(L.t("herd_lenses_label"))
        .accessibilityIdentifier("herd-lenses-top")
    }

    private var bottomBar: some View {
        HStack(spacing: 0) {
            ForEach(layout.stripLenses, id: \.self) { lensButton($0, bottom: true) }
            Button { showingRepos = true } label: {
                VStack(spacing: 4) {
                    Image(systemName: "folder").accessibilityHidden(true)
                    Text(verbatim: L.t("actionbar_backlog").uppercased())
                        .fixedSize(horizontal: false, vertical: true)
                }
                .sessionFont(label: true, weight: .medium)
                .foregroundStyle(activeRepos.isEmpty ? SessionListStyle.ink : SessionListStyle.amber)
                .padding(.horizontal, 4).padding(.vertical, 8)
                .frame(minWidth: 44, maxWidth: .infinity, minHeight: 48)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(L.t("repo_switcher_label"))
            .accessibilityValue(activeRepos.sorted().map { ($0 as NSString).lastPathComponent }.joined(separator: ", "))
            .accessibilityIdentifier("show-repos")
            if app.liveRequestAudit == nil { newTaskButton(bottom: true) }
        }
        .background(SessionListStyle.panel.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { Rectangle().fill(SessionListStyle.brightLine).frame(height: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L.t("herd_lenses_label"))
        .accessibilityIdentifier("herd-lenses-bottom")
    }

    private func newTaskButton(bottom: Bool) -> some View {
        Button { if let hub { hub.openComposer() } else { IOSComposer.open(app) } } label: {
            VStack(spacing: 4) {
                Image(systemName: "plus").accessibilityHidden(true)
                Text(verbatim: L.t("actionbar_new_task_short").uppercased())
                    .fixedSize(horizontal: false, vertical: true)
            }
            .sessionFont(label: true, weight: .semibold)
            .foregroundStyle(SessionListStyle.amber)
            .padding(.horizontal, bottom ? 4 : 10).padding(.vertical, 8)
            .frame(minWidth: 44, maxWidth: bottom ? .infinity : nil, minHeight: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(hub.map { $0.composeModel == nil } ?? (app.store == nil))
        .accessibilityLabel(L.t("actionbar_new_task"))
        .accessibilityIdentifier("new-task")
    }

    private var header: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) { wordmark; tallies }
            VStack(alignment: .leading, spacing: 2) { wordmark; tallies }
        }
    }

    private var wordmark: some View {
        (Text(verbatim: "SHEP").foregroundColor(SessionListStyle.bright)
            + Text(verbatim: "HERD").foregroundColor(SessionListStyle.amber))
            .sessionFont(weight: .semibold)
            .accessibilityLabel("Shepherd")
    }

    private var tallies: some View {
        HStack(spacing: 8) {
            tally("", presentation.tallies.total, key: "native_herd_counter_total", tint: SessionListStyle.ink)
            tally("●", presentation.tallies.active, key: "native_herd_counter_active", tint: SessionListStyle.amber)
            tally("·", presentation.tallies.idle, key: "native_herd_counter_idle", tint: SessionListStyle.muted)
            tally("!", presentation.tallies.blocked, key: "native_herd_counter_blocked", tint: SessionListStyle.red)
        }
        .sessionFont(label: true)
        .accessibilityIdentifier("herd-tallies")
    }

    private func tally(_ glyph: String, _ count: Int, key: StaticString, tint: Color) -> some View {
        Text(verbatim: "\(glyph)\(count)").foregroundStyle(tint).monospacedDigit()
            .accessibilityLabel(Text(verbatim: "\(L.t(key)): \(count)"))
    }

    private var settingsMenu: some View {
        Menu {
            ForEach(layout.menuLenses, id: \.self) { lens in
                Button { setLens(lens) } label: {
                    if lens == .owed {
                        Text(verbatim: "\(L.t(lens.labelKey)) · \(owedCount)")
                    } else { Text(verbatim: L.t(lens.labelKey)) }
                }
                .accessibilityValue(lens == .owed ? owedAccessibilityValue : "")
                .accessibilityAddTraits(self.lens == lens ? .isSelected : [])
                .accessibilityIdentifier("herd-lens-\(lens.rawValue)")
            }
            Divider()
            if IOSPushRegistration.shared.isEnabled {
                Section(L.t("native_ios_push_title")) {
                    // The same server the sign-out below acts on.
                    Text(verbatim: IOSPushRegistration.shared.statusText(for: hub?.focused.store ?? app.store))
                        .accessibilityIdentifier("push-status")
                }
            }
            Button(L.t("native_toolbar_servers")) {
                if let hub { hub.managingServers = true } else { app.deactivate() }
            }
                .accessibilityIdentifier("show-servers")
            Button(L.t("native_toolbar_sign_out")) { Task {
                if let hub { await hub.signOutFocused() } else { await app.signOutActiveReporting() }
            } }
                .accessibilityIdentifier("sign-out")
        } label: {
            HStack(spacing: 3) {
                Image(systemName: "gearshape")
                if layout.bottomBar {
                    Text(verbatim: owedCount).sessionFont(label: true).monospacedDigit()
                        .padding(.horizontal, 3)
                        .overlay { RoundedRectangle(cornerRadius: 2).stroke(SessionListStyle.amber, lineWidth: 0.5) }
                        .accessibilityIdentifier("herd-owed-count")
                }
            }
            .foregroundStyle(SessionListStyle.ink)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(L.t("topbar_settings_aria"))
        .accessibilityValue(layout.bottomBar ? owedAccessibilityValue : "")
        .accessibilityIdentifier("session-settings")
    }

    private var owedAccessibilityValue: String {
        let merges = (hub?.connected ?? [app]).compactMap { $0.extension(MergeModel.self) }
        if let error = merges.compactMap(\.error).first { return error }
        if merges.count != (hub?.connected.count ?? 1) || merges.contains(where: { !$0.settled }) { return L.t("common_loading") }
        return L.t("native_ios_open_items_count", String(presentation.owed.count))
    }

    private func repoRail(_ chips: [IOSMergedSessionPresentation.Chip]) -> some View {
        ScrollView(.horizontal) {
            HStack(spacing: 6) {
                ForEach(chips) { chip in
                    let selected = activeRepos.contains(chip.path)
                    Button { toggleRepo(chip.path) } label: {
                        HStack(spacing: 5) {
                            Text(verbatim: chip.name)
                            Text(verbatim: String(chip.count)).monospacedDigit()
                        }
                        .sessionFont(label: true)
                        .foregroundStyle(selected ? SessionListStyle.amber : SessionListStyle.muted)
                        .padding(.horizontal, 8).frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text(verbatim: selected ? L.t("repo_filter_active_aria", chip.name) : L.t("repo_filter_apply_aria", chip.name)))
                    .accessibilityAddTraits(selected ? .isSelected : [])
                    .accessibilityIdentifier("repo-chip-\(chip.name)")
                }
            }.padding(.horizontal, 6)
        }
        .scrollIndicators(.never)
        .overlay(alignment: .bottom) { Rectangle().fill(SessionListStyle.line).frame(height: 1) }
        .accessibilityLabel(L.t("repo_switcher_label"))
    }

    private func groupHeader(_ stage: HerdStage, title: String) -> some View {
        let collapsed = collapsedStages.contains(stage)
        return HStack(spacing: 0) {
            Button { toggleCollapsed(stage) } label: {
                HStack(spacing: 6) {
                    Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                    Text(verbatim: title.uppercased())
                    Spacer(minLength: 0)
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(.isHeader)
            .accessibilityValue(collapsed ? L.t("native_ios_group_collapsed") : L.t("native_ios_group_expanded"))
            .accessibilityIdentifier("herd-group-\(stage.rawValue)")
            if IOSSessionListPresentation.groupHelp(stage) != nil {
                Button { explanationTitle = title; explainingStage = stage } label: {
                    Image(systemName: "info.circle")
                        .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(verbatim: L.t("newtask_info_aria", title)))
                .accessibilityIdentifier("herd-group-info-\(stage.rawValue)")
            }
        }
        .sessionFont(label: true, weight: .medium)
        .foregroundStyle(SessionListStyle.blue)
        .listRowInsets(EdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 6))
        .listRowBackground(SessionListStyle.background).listRowSeparator(.hidden)
    }

    private func card(_ row: IOSMergedSessionPresentation.Row, showCli: Bool, now: Int, leading: CGFloat = 10) -> some View {
        let session = row.session
        let app = hub?.models[row.profile.id] ?? app
        let model = app.extension(SidebarModel.self) ?? model
        let herd = app.extension(HerdSignals.self)
        let presentation = IOSSessionListPresentation.card(session, displayed: model.rendered(session),
            git: herd?.git[session.id], verdict: herd?.verdicts[session.id], reviewing: herd?.isReviewing(session.id) ?? false,
            block: model.block(for: session.id), recap: recap(for: session.id, app: app), activity: herd?.activity[session.id],
            questionsUnanswered: app.extension(PlanModel.self)?.questionsUnanswered(session.id) ?? false,
            planGate: app.extension(PlanModel.self)?.gates[session.id],
            planReviewing: app.extension(PlanModel.self)?.reviewing.contains(session.id) ?? false,
            showCli: showCli, repoAutopilotDefault: herd?.repoAutopilotDefault(session.repoPath), now: now)
        return SessionCardView(card: presentation, selected: app.selectedSessionID == session.id,
            serverName: IOSMergedSessionPresentation.serverHint(row.profile, connectedCount: hub?.connected.count ?? 1),
            rowID: (hub?.connected.count ?? 1) > 1 ? "\(row.profile.id)-\(session.id)" : nil) { selectRow(row.id) }
            .modifier(IOSSessionSwipeActions(session: session))
            .environment(app)
            .listRowInsets(EdgeInsets(top: 0, leading: leading, bottom: 0, trailing: 10))
            .listRowBackground(SessionListStyle.background).listRowSeparator(.hidden)
    }

    private func empty(_ text: String) -> some View {
        Text(verbatim: text).sessionFont().foregroundStyle(SessionListStyle.muted)
            .padding(.vertical, 20).listRowBackground(SessionListStyle.background).listRowSeparator(.hidden)
    }

    private func recap(for id: String, app: AppModel) -> Recap? {
        let live = app.extension(ActionsModel.self)?.recap(for: id)
        let cached = app.extension(QueuesModel.self)?.recap(for: id)
        if let cached, cached.updatedAt > (live?.updatedAt ?? -1) { return cached }
        return live ?? cached
    }

    private func refresh() async {
        refreshError = nil
        let tasks = (hub?.connected ?? [app]).map { owner in
            Task { @MainActor () -> String? in
                let generation = owner.activationGeneration
                do { try await owner.store?.refresh() }
                catch {
                    guard generation == owner.activationGeneration, !Task.isCancelled else { return nil }
                    return ShepherdErrorCopy.message(error)
                }
                guard generation == owner.activationGeneration, !Task.isCancelled else { return nil }
                await owner.extension(ReadOnlySidebarRecovery.self)?.refresh()
                return nil
            }
        }
        for task in tasks { if let error = await task.value { refreshError = error } }
        await epicDirectory.load(presentation.epicGroups, owners: hub?.models ?? [:], fallback: app, force: true)
    }
}
