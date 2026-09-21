import ShepherdAppCore
import SwiftUI
import ShepherdKit

/// One lifecycle group: a collapsible header carrying its count, then its rows. The `active` stage
/// has no heading (the web renders it headerless), so it is never collapsible either.
struct HerdGroupView: View {
    @Environment(AppModel.self) private var app
    let group: HerdGroup
    let isCollapsed: Bool
    /// `SidebarModel.rendered` — the session as it must render, with `HerdPartition.displayStatus`
    /// applied. `SessionRow` is another stream's file and paints whatever `status` it is handed, so
    /// the display-status upgrade has to happen on the way in or the row contradicts the tallies
    /// and the Ready lens, which both already go through `displayStatus`.
    let display: (Session) -> Session
    let block: (String) -> BlockReason?
    let onToggle: () -> Void

    static func heading(_ group: HerdGroup, git: [String: GitState]) -> String? {
        let names = group.sessions.map { git[$0.id]?.handoffWho }.map { name in
            name?.isEmpty == false ? name : nil
        }
        let unique = Set(names)
        let who = unique.count == 1 ? names.first.flatMap { $0 } : nil
        let count = String(group.sessions.count)
        if who == nil, names.allSatisfy({ $0 == nil }) {
            if group.stage == .waitingOnReviewer { return L.t("herd_waiting_reviewer_group_maintainers", count) }
            if group.stage == .waitingOnMerger { return L.t("herd_waiting_merger_group_maintainers", count) }
        }
        guard let key = group.stage.headingKey(who: who) else { return nil }
        if let who { return L.t(key, who, count) }
        return L.t(key, count)
    }

    var body: some View {
        let showCli = SessionBadges.showsCli(for: app.extension(SidebarModel.self)?.sessions ?? group.sessions)
        Section {
            if !isCollapsed {
                ForEach(group.sessions, id: \.id) { session in
                    VStack(alignment: .leading, spacing: 3) {
                        SessionRow(session: display(session))
                            .modifier(SettingsStatusShape(status: display(session).status))
                        // Row predicates read the raw session, matching UnitRowRight;
                        // the display-status upgrade belongs only to SessionRow.
                        if let plan = app.extension(PlanModel.self) {
                            HStack {
                                PlanGateBadgeView(session: session, model: plan, allowView: false) {
                                    app.selectedSessionID = session.id
                                    plan.openPlan(session.id)
                                }
                                if SessionSignals.planQuestionsUnanswered(session.id) {
                                    Button(L.t("hold_cta_answer")) {
                                        app.selectedSessionID = session.id
                                        plan.openPlan(session.id)
                                    }
                                    .help(L.t("hold_cta_answer_title"))
                                    .accessibilityIdentifier("plan-answer-\(session.id)")
                                }
                            }
                        }
                        HerdRowSignals(session: session, block: block(session.id), showCli: showCli)
                    }
                    .tag(session.id)
                }
            }
        } header: {
            if let title = Self.heading(group, git: app.extension(HerdSignals.self)?.git ?? [:]) {
                Button(action: onToggle) {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.down")
                            .font(.caption2)
                            .rotationEffect(.degrees(isCollapsed ? -90 : 0))
                        Text(verbatim: title)
                        Spacer(minLength: 0)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("herd-group-\(group.stage.rawValue)")
            }
        }
    }
}
