import SwiftUI
import ShepherdAppCore
import ShepherdKit

/// One PR row with the server it came from; the merged list carries several servers.
struct IOSUpNextPrRow: Identifiable {
    let pr: UpNextPr
    let app: AppModel
    let serverName: String?
    /// Fixtures render with a controller of their own; production reads the app's.
    var fixtureController: IOSUpNextPrController?
    let id: String

    init(pr: UpNextPr, app: AppModel, serverName: String?, fixtureController: IOSUpNextPrController? = nil) {
        self.pr = pr; self.app = app; self.serverName = serverName; self.fixtureController = fixtureController
        id = "\(ObjectIdentifier(app).hashValue):\(UpNextPrPresentation.key(pr))"
    }

    @MainActor var controller: IOSUpNextPrController? { fixtureController ?? app.extension(IOSUpNextPrController.self) }

    /// Every connected server's PR block, in server order.
    @MainActor static func rows(_ apps: [AppModel], named: Bool) -> [IOSUpNextPrRow] {
        apps.flatMap { app in
            UpNextPrs.parse(app.extension(QueuesModel.self)?.upNext).map {
                IOSUpNextPrRow(pr: $0, app: app, serverName: named ? app.activeProfile?.name : nil)
            }
        }
    }
}

/// Filter and sort as one compact bar: "Filter · N rules" on the left, the sort menu on the right.
struct IOSUpNextToolbar: View {
    let filter: IOSUpNextFilter
    @Binding var sort: UpNextSort
    @Binding var filterOpen: Bool

    var body: some View {
        HStack(spacing: 0) {
            if filter.isAvailable {
                Button { filterOpen = true } label: {
                    Label {
                        Text(verbatim: Self.filterTitle(filter.count))
                    } icon: { Image(systemName: "line.3.horizontal.decrease").accessibilityHidden(true) }
                    .sessionFont(label: true, weight: .semibold)
                    .foregroundStyle(filter.isActive ? SessionListStyle.amber : SessionListStyle.ink)
                    .padding(.horizontal, 12)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L.t("upnext_filter_button_aria", String(filter.count)))
                .accessibilityIdentifier("queues-upnext-filter")
            }
            Spacer(minLength: 8)
            Menu {
                Picker(L.t("upnext_sort_aria"), selection: $sort) {
                    ForEach(UpNextSort.allCases, id: \.self) { Text(verbatim: $0.label).tag($0) }
                }
            } label: {
                HStack(spacing: 4) {
                    Text(verbatim: sort.label)
                    Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)).accessibilityHidden(true)
                }
                .sessionFont(label: true, weight: .semibold)
                .foregroundStyle(SessionListStyle.amber)
                .padding(.horizontal, 12)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
            }
            .accessibilityLabel(L.t("upnext_sort_aria"))
            .accessibilityValue(Text(verbatim: sort.label))
            .accessibilityIdentifier("queues-upnext-sort")
        }
        .listRowBackground(SessionListStyle.panel).listRowSeparator(.hidden)
        .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 8))
    }

    static func filterTitle(_ count: Int) -> String {
        switch count {
        case 0: L.t("native_ios_upnext_pr_toolbar_filter_none")
        case 1: L.t("native_ios_upnext_pr_toolbar_filter_one")
        default: L.t("native_ios_upnext_pr_toolbar_filter", String(count))
        }
    }
}

/// "PULL REQUESTS 9" / "ISSUES 15": a section label with its count.
struct IOSUpNextSectionLabel: View {
    let title: String
    let count: Int
    let identifier: String
    var body: some View {
        HStack {
            Text(verbatim: title.uppercased()).foregroundStyle(SessionListStyle.bright).kerning(1.2)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            Text(verbatim: String(count)).foregroundStyle(SessionListStyle.muted).monospacedDigit()
        }
        .sessionFont(label: true, weight: .semibold)
        .padding(.top, 10)
        .listRowBackground(SessionListStyle.background).listRowSeparator(.hidden)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(identifier)
    }
}

/// The PR block above the issue groups: one tinted group per band, the Dependabot group folded
/// into a summary card with its merge-train button, and the PR sheet over any row.
struct IOSUpNextPrSection: View {
    let rows: [IOSUpNextPrRow]
    let sort: UpNextSort
    let repos: Set<String>
    let select: (AppModel, String) -> Void
    @State private var selection: IOSUpNextPrSelection?
    @State private var dependabotExpanded = false
    @State private var train: IOSUpNextTrainRequest?
    @State private var clock = Date()

    private var groups: [IOSUpNextPrGroupRows] {
        UpNextPrPresentation.banded(rows, sort: sort, repos: repos, pr: \.pr).map { .init(band: $0.band, items: $0.items) }
    }
    /// The sheet pages through the rows in list order.
    private var ordered: [IOSUpNextPrRow] { groups.flatMap(\.items) }

    var body: some View {
        let groups = groups
        if !groups.isEmpty {
            IOSUpNextSectionLabel(title: L.t("native_ios_upnext_pr_section"), count: ordered.count,
                                  identifier: "queues-upnext-pr-section")
                // On the one label row: a modifier on the whole section would repeat per List row.
                .sheet(item: $selection) { selection in
                    IOSUpNextPrSheet(rows: ordered, initial: selection, select: select)
                }
                .sheet(item: Binding(get: { selection == nil ? mergeOwner : nil },
                                     set: { if $0 == nil { mergeOwner?.controller?.dismissMerge() } })) { owner in
                    if let controller = owner.controller { IOSUpNextPrMergeSheet(controller: controller) }
                }
                .confirmationDialog(L.t("mergetrain_confirm_title"),
                    isPresented: Binding(get: { train != nil }, set: { if !$0 { train = nil } }),
                    titleVisibility: .visible, presenting: train) { request in
                    Button(L.t("mergetrain_confirm_action")) {
                        let plan = request.plan, app = request.app
                        Task<Void, Never> { _ = await app.extension(IOSUpNextPrController.self)?.startTrain(plan) { select(app, $0) } }
                    }
                    Button(L.t("common_cancel"), role: .cancel) {}
                } message: { request in Text(verbatim: request.message) }
            feedback
            ForEach(groups) { group in
                IOSUpNextPrGroupTitle(band: group.band, count: group.items.count,
                                      train: group.band == .dependabot ? { startTrain(group.items) } : nil)
                if group.band == .dependabot, !dependabotExpanded {
                    IOSUpNextDependabotCard(rows: group.items) { dependabotExpanded = true }
                } else {
                    ForEach(group.items) { row in
                        IOSUpNextPrCard(row: row, now: clock) { selection = .init(row: row) }
                            .modifier(IOSUpNextPrSwipe(row: row))
                    }
                }
            }
        }
    }

    /// Who is confirming a merge from a swipe; the PR sheet presents its own confirmation.
    private var mergeOwner: IOSUpNextPrRow? {
        rows.first { $0.controller?.mergeDraft != nil }
    }

    /// One feedback line per server with PRs in the list.
    private var feedbackOwners: [IOSUpNextPrRow] {
        var seen = Set<ObjectIdentifier>()
        return rows.filter { seen.insert(ObjectIdentifier($0.app)).inserted }
    }

    @ViewBuilder private var feedback: some View {
        ForEach(feedbackOwners) { row in
            if let controller = row.controller, controller.error != nil || controller.note != nil || controller.busy {
                Button { controller.clearFeedback() } label: {
                    IOSActionFeedback(error: controller.error, note: controller.note, busy: controller.busy)
                }
                .buttonStyle(.plain).listRowBackground(SessionListStyle.background)
                .accessibilityIdentifier("queues-upnext-pr-feedback")
            }
        }
    }

    /// The train takes the Dependabot PRs the server left unblocked with green CI, in the repo
    /// with the most of them; the server that owns that repo runs it.
    private func startTrain(_ items: [IOSUpNextPrRow]) {
        guard let (plan, owner) = Self.trainPlan(items) else {
            items.first?.controller?.note = .warning(L.t("native_ios_upnext_pr_train_none"))
            return
        }
        guard owner.controller?.allowsWrites == true, owner.controller?.busy == false else { return }
        var message = L.t("native_ios_upnext_pr_train_confirm_body", String(plan.prs.count), plan.repoLabel)
        if plan.otherRepoCount > 0 { message += "\n" + L.t("mergetrain_confirm_other_repos", String(plan.otherRepoCount)) }
        train = .init(plan: plan, app: owner.app, message: message)
    }

    /// One plan per server, so two servers carrying the same repo path never share a train;
    /// the biggest plan wins and the rest count as other repos.
    static func trainPlan(_ items: [IOSUpNextPrRow]) -> (plan: UpNextMergeTrainPlan, owner: IOSUpNextPrRow)? {
        var order: [ObjectIdentifier] = []
        var byServer: [ObjectIdentifier: [IOSUpNextPrRow]] = [:]
        for row in items {
            let id = ObjectIdentifier(row.app)
            if byServer[id] == nil { order.append(id) }
            byServer[id, default: []].append(row)
        }
        let plans = order.compactMap { id -> (UpNextMergeTrainPlan, IOSUpNextPrRow)? in
            guard let rows = byServer[id], let plan = UpNextPrPresentation.trainPlan(rows.map(\.pr)),
                  let owner = rows.first(where: { $0.pr.repoPath == plan.repoPath }) else { return nil }
            return (plan, owner)
        }
        guard let best = plans.max(by: { $0.0.prs.count < $1.0.prs.count }) else { return nil }
        let candidates = UpNextPrPresentation.trainCandidates(items.map(\.pr)).count
        let plan = UpNextMergeTrainPlan(repoPath: best.0.repoPath, repoLabel: best.0.repoLabel, prs: best.0.prs,
                                        otherRepoCount: candidates - best.0.prs.count)
        return (plan, best.1)
    }
}

struct IOSUpNextPrGroupRows: Identifiable {
    let band: UpNextPr.Band
    let items: [IOSUpNextPrRow]
    var id: String { band.rawValue }
}

struct IOSUpNextPrSelection: Identifiable, Equatable {
    let id: String
    init(row: IOSUpNextPrRow) { id = row.id }
    init(id: String) { self.id = id }
}

struct IOSUpNextTrainRequest {
    let plan: UpNextMergeTrainPlan
    let app: AppModel
    let message: String
}

/// "● Ready to merge 2", tinted per band, with the Dependabot group's "Merge train ›" on the right.
struct IOSUpNextPrGroupTitle: View {
    let band: UpNextPr.Band
    let count: Int
    var train: (() -> Void)?

    static func tint(_ band: UpNextPr.Band) -> Color {
        switch band {
        case .ready: SessionListStyle.green
        case .review: SessionListStyle.violet
        case .blocked: SessionListStyle.warn
        case .dependabot: SessionListStyle.blue
        }
    }

    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(Self.tint(band)).frame(width: 7, height: 7).accessibilityHidden(true)
            Text(verbatim: UpNextPrPresentation.bandTitle(band)).foregroundStyle(Self.tint(band))
            Text(verbatim: String(count)).foregroundStyle(SessionListStyle.muted).monospacedDigit()
            Spacer(minLength: 8)
            if let train {
                Button(action: train) {
                    Text(verbatim: L.t("native_ios_upnext_pr_train_button")).sessionFont(label: true, weight: .semibold)
                        .foregroundStyle(SessionListStyle.amber).kerning(0.6)
                        .padding(.horizontal, 8).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L.t("native_ios_upnext_pr_train_aria"))
                .accessibilityIdentifier("queues-upnext-pr-train")
            }
        }
        .sessionFont(weight: .semibold)
        .frame(minHeight: 30)
        .listRowBackground(SessionListStyle.background).listRowSeparator(.hidden)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("queues-upnext-pr-group-\(band.rawValue)")
    }
}

/// The card's status line: the block label, the CI light and the repo.
struct IOSUpNextPrStatusLine: View {
    let tokens: [UpNextPrPresentation.StatusToken]
    let repoLabel: String?

    static func color(_ tone: UpNextPrPresentation.Tone) -> Color {
        switch tone {
        case .green: SessionListStyle.green
        case .red: SessionListStyle.red
        case .amber: SessionListStyle.amber
        case .muted: SessionListStyle.muted
        }
    }

    var body: some View {
        HStack(spacing: 10) {
            ForEach(Array(tokens.enumerated()), id: \.offset) { _, token in
                HStack(spacing: 5) {
                    if token.dot { Circle().fill(Self.color(token.tone)).frame(width: 7, height: 7).accessibilityHidden(true) }
                    Text(verbatim: token.text).kerning(token.dot ? 0 : 0.6)
                }
                .foregroundStyle(Self.color(token.tone))
            }
            if let repoLabel { Text(verbatim: repoLabel).foregroundStyle(SessionListStyle.muted) }
        }
        .sessionFont(label: true)
        .lineLimit(1)
    }

    static func accessibilityText(_ tokens: [UpNextPrPresentation.StatusToken]) -> String {
        tokens.map(\.text).joined(separator: ", ")
    }
}

/// "#911 Title" with its status line and a chevron; one tap opens the sheet.
struct IOSUpNextPrCard: View {
    let row: IOSUpNextPrRow
    var now = Date()
    let open: () -> Void

    var body: some View {
        let pr = row.pr
        let tokens = UpNextPrPresentation.statusTokens(pr)
        Button(action: open) {
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(verbatim: "#\(pr.number) \(pr.title)").sessionFont(weight: .semibold).foregroundStyle(SessionListStyle.ink)
                    IOSUpNextPrStatusLine(tokens: tokens, repoLabel: pr.repoLabel)
                    if let name = row.serverName { IOSServerHint(name: name) }
                }
                Spacer(minLength: 4)
                Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(SessionListStyle.muted).accessibilityHidden(true)
            }
            .padding(.vertical, 10)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(SessionListStyle.panel)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: L.t("native_ios_upnext_pr_row_aria", String(pr.number), pr.title,
                                                IOSUpNextPrStatusLine.accessibilityText(tokens), pr.repoLabel)))
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("queues-upnext-pr-row-\(UpNextPrPresentation.key(pr))")
    }
}

/// The trailing swipe on a mergeable PR opens the merge confirmation; it never merges directly.
struct IOSUpNextPrSwipe: ViewModifier {
    let row: IOSUpNextPrRow
    func body(content: Content) -> some View {
        if let controller = row.controller, Self.offersMerge(row.pr), controller.allowsWrites {
            content.swipeActions(edge: .trailing, allowsFullSwipe: false) {
                Button { controller.prepareMerge(row.pr) } label: {
                    Label(L.t("native_ios_upnext_pr_swipe_merge"), systemImage: "arrow.triangle.merge")
                }
                .tint(SessionListStyle.green)
                .disabled(controller.busy)
                .accessibilityIdentifier("queues-upnext-pr-swipe-merge-\(UpNextPrPresentation.key(row.pr))")
            }
        } else { content }
    }

    static func offersMerge(_ pr: UpNextPr) -> Bool { pr.action == .merge }
}

/// "4 updates · all CI green": the Dependabot group folded; a tap unfolds its rows.
struct IOSUpNextDependabotCard: View {
    let rows: [IOSUpNextPrRow]
    let expand: () -> Void

    var body: some View {
        let prs = rows.map(\.pr)
        let summary = UpNextPrPresentation.dependabotSummary(prs)
        let repos = Set(prs.map(\.repoLabel))
        Button(action: expand) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(verbatim: summary.title).sessionFont(weight: .semibold).foregroundStyle(SessionListStyle.ink)
                    IOSUpNextPrStatusLine(tokens: [summary.ci], repoLabel: repos.count == 1 ? repos.first : nil)
                }
                Spacer(minLength: 4)
                Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(SessionListStyle.muted).accessibilityHidden(true)
            }
            .padding(.vertical, 10)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(SessionListStyle.panel)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("queues-upnext-pr-dependabot-summary")
    }
}

/// The lens glyph with the green "ready to merge" counter at its top right.
struct IOSUpNextLensBadge: View {
    let count: Int
    var body: some View {
        Text(verbatim: String(count))
            .font(.system(size: 10, weight: .bold, design: .monospaced))
            .foregroundStyle(SessionListStyle.background)
            .padding(.horizontal, 4)
            .frame(minWidth: 15, minHeight: 15)
            .background(Capsule().fill(SessionListStyle.green))
            .accessibilityHidden(true)
    }
}
