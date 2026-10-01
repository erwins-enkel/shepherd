import SwiftUI
import ShepherdAppCore
import ShepherdKit

struct SessionListView: View {
    let model: SidebarModel
    let select: (String) -> Void
    @Environment(AppModel.self) private var app
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
        .sheet(isPresented: $showingRepos) { SessionReposSheet(model: model) }
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
        .onChange(of: selectionIDs) { _, ids in app.reconcileSelection(against: ids) }
    }

    private var queues: QueuesModel? { app.extension(QueuesModel.self) }
    private var herd: HerdSignals? { app.extension(HerdSignals.self) }
    private var merge: MergeModel? { app.extension(MergeModel.self) }
    private var owedCount: String {
        merge?.settled == true && merge?.error == nil ? String(owed.count) : "—"
    }
    private var owed: [PostMergeSteps] {
        IOSSessionListPresentation.outstanding(app.extension(MergeModel.self)?.snapshot.owed ?? [], repos: model.activeRepos)
    }
    private var selectionIDs: [String] {
        (app.store?.sessions.map(\.id) ?? []) + (queues?.finishedSessions.map(\.id) ?? [])
    }

    private func content(now: Int) -> some View {
        let chips = model.chips
        let groups = IOSSessionListPresentation.groups(model)
        let showCli = SessionBadges.showsCli(for: model.sessions)
        return VStack(spacing: 0) {
            HStack(spacing: 10) { header; Spacer(minLength: 0); settingsMenu }
                .padding(.horizontal, 12).padding(.vertical, 5)
                .background(SessionListStyle.panel)
                .overlay(alignment: .bottom) { Rectangle().fill(SessionListStyle.brightLine).frame(height: 1) }
            if !layout.bottomBar { lensStrip }
            if layout.repoRail, model.showsRepoRail(chips) { repoRail(chips) }
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
                if layout.bottomBar, layout.menuLenses.contains(model.lens) {
                    Text(verbatim: L.t(model.lens.labelKey).uppercased()).sessionFont(label: true, weight: .semibold)
                        .foregroundStyle(SessionListStyle.amber).accessibilityAddTraits(.isHeader)
                        .listRowBackground(SessionListStyle.background).listRowSeparator(.hidden)
                }
                switch model.lens {
                case .all, .ready:
                    if groups.isEmpty, app.store?.connection == .live {
                        empty(SidebarCopy.empty(lens: model.lens, repos: model.activeRepos))
                    }
                    ForEach(groups) { group in
                        if let heading = SidebarCopy.heading(group, git: herd?.git ?? [:]) {
                            groupHeader(group.stage, title: heading)
                        }
                        if group.stage == .active || !model.collapsedStages.contains(group.stage) {
                            ForEach(group.sessions, id: \.id) { session in card(session, showCli: showCli, now: now) }
                        }
                    }
                case .done:
                    let sessions = IOSSessionListPresentation.finished(queues?.finishedSessions ?? [], repos: model.activeRepos)
                    if queues?.isRefreshing == true, sessions.isEmpty { ProgressView(L.t("common_loading")) }
                    else if sessions.isEmpty { empty(L.t("herd_done_empty")) }
                    ForEach(sessions, id: \.id) { session in card(session, showCli: SessionBadges.showsCli(for: sessions), now: now) }
                case .next: IOSUpNextRows(model: queues, repos: model.activeRepos)
                case .owed: IOSOwedRows(records: owed, model: app.extension(MergeModel.self), select: select)
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
        SessionLensButton(lens: lens, selected: model.lens == lens, bottom: bottom,
            owedCount: owedCount, owedAccessibilityValue: owedAccessibilityValue) { model.lens = lens }
    }

    private var lensStrip: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 0) {
                ForEach(layout.stripLenses, id: \.self) { lensButton($0, bottom: false) }
            }
        }
        .scrollIndicators(.never)
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
                .foregroundStyle(model.activeRepos.isEmpty ? SessionListStyle.ink : SessionListStyle.amber)
                .padding(.horizontal, 4).padding(.vertical, 8)
                .frame(minWidth: 44, maxWidth: .infinity, minHeight: 48)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(L.t("repo_switcher_label"))
            .accessibilityValue(model.activeRepos.sorted().map { ($0 as NSString).lastPathComponent }.joined(separator: ", "))
            .accessibilityIdentifier("show-repos")
        }
        .background(SessionListStyle.panel.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { Rectangle().fill(SessionListStyle.brightLine).frame(height: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L.t("herd_lenses_label"))
        .accessibilityIdentifier("herd-lenses-bottom")
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
            tally("", model.tallies.total, key: "native_herd_counter_total", tint: SessionListStyle.ink)
            tally("●", model.tallies.active, key: "native_herd_counter_active", tint: SessionListStyle.amber)
            tally("·", model.tallies.idle, key: "native_herd_counter_idle", tint: SessionListStyle.muted)
            tally("!", model.tallies.blocked, key: "native_herd_counter_blocked", tint: SessionListStyle.red)
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
                Button { model.lens = lens } label: {
                    if lens == .owed {
                        Text(verbatim: "\(L.t(lens.labelKey)) · \(owedCount)")
                    } else { Text(verbatim: L.t(lens.labelKey)) }
                }
                .accessibilityValue(lens == .owed ? owedAccessibilityValue : "")
                .accessibilityAddTraits(model.lens == lens ? .isSelected : [])
                .accessibilityIdentifier("herd-lens-\(lens.rawValue)")
            }
            Divider()
            Button(L.t("native_toolbar_servers")) { app.deactivate() }
                .accessibilityIdentifier("show-servers")
            Button(L.t("native_toolbar_sign_out")) { Task { await app.signOutActiveReporting() } }
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
        if let error = merge?.error { return error }
        if merge?.settled != true { return L.t("common_loading") }
        return L.t("native_ios_open_items_count", String(owed.count))
    }

    private func repoRail(_ chips: [HerdRepoChip]) -> some View {
        ScrollView(.horizontal) {
            HStack(spacing: 6) {
                ForEach(chips) { chip in
                    let selected = model.activeRepos.contains(chip.path)
                    Button { model.toggleRepo(chip.path, additive: false) } label: {
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
        let collapsed = model.collapsedStages.contains(stage)
        return HStack(spacing: 0) {
            Button { model.toggleCollapsed(stage) } label: {
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

    private func card(_ session: Session, showCli: Bool, now: Int) -> some View {
        let presentation = IOSSessionListPresentation.card(session, displayed: model.rendered(session),
            git: herd?.git[session.id], verdict: herd?.verdicts[session.id], reviewing: herd?.isReviewing(session.id) ?? false,
            block: model.block(for: session.id), recap: recap(for: session.id), activity: herd?.activity[session.id],
            questionsUnanswered: app.extension(PlanModel.self)?.questionsUnanswered(session.id) ?? false,
            showCli: showCli, repoAutopilotDefault: herd?.repoAutopilotDefault(session.repoPath), now: now)
        return SessionCardView(card: presentation, selected: app.selectedSessionID == session.id) { select(session.id) }
            .listRowInsets(EdgeInsets(top: 0, leading: 10, bottom: 0, trailing: 10))
            .listRowBackground(SessionListStyle.background).listRowSeparator(.hidden)
    }

    private func empty(_ text: String) -> some View {
        Text(verbatim: text).sessionFont().foregroundStyle(SessionListStyle.muted)
            .padding(.vertical, 20).listRowBackground(SessionListStyle.background).listRowSeparator(.hidden)
    }

    private func recap(for id: String) -> Recap? {
        let live = app.extension(ActionsModel.self)?.recap(for: id)
        let cached = queues?.recap(for: id)
        if let cached, cached.updatedAt > (live?.updatedAt ?? -1) { return cached }
        return live ?? cached
    }

    private func refresh() async {
        let generation = app.activationGeneration
        refreshError = nil
        do { try await app.store?.refresh() }
        catch {
            guard generation == app.activationGeneration, !Task.isCancelled else { return }
            refreshError = ShepherdErrorCopy.message(error)
        }
        guard generation == app.activationGeneration, !Task.isCancelled else { return }
        async let sidebar: Void = model.refresh()
        async let signals: Void? = herd?.refresh()
        async let queue: Void? = queues?.refresh(recomputeUpNext: false)
        async let merge: Void? = app.extension(MergeModel.self)?.refresh()
        async let plan: Void? = app.extension(PlanModel.self)?.refresh()
        _ = await (sidebar, signals, queue, merge, plan)
    }
}
