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
    let contextMenu: SessionContextController
    let onToggle: () -> Void

    static func heading(_ group: HerdGroup, git: [String: GitState]) -> String? {
        SidebarCopy.heading(group, git: git)
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
                                PlanGateBadgeView(session: session, model: plan, allowView: false, isSidebar: true) {
                                    app.selectedSessionID = session.id
                                    plan.openPlan(session.id)
                                }
                                if SessionSignals.planQuestionsUnanswered(session.id) {
                                    Button(L.t("hold_cta_answer")) {
                                        app.selectedSessionID = session.id
                                        plan.openPlan(session.id)
                                    }
                                    .buttonStyle(ShepherdSidebarButtonStyle(primary: true))
                                    .help(L.t("hold_cta_answer_title"))
                                    .accessibilityIdentifier("plan-answer-\(session.id)")
                                }
                            }
                        }
                        HerdRowSignals(session: session, block: block(session.id), showCli: showCli)
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(app.selectedSessionID == session.id ? ShepherdPalette.sel : ShepherdPalette.panel,
                        in: RoundedRectangle(cornerRadius: 6))
                    .overlay { RoundedRectangle(cornerRadius: 6)
                        .stroke(app.selectedSessionID == session.id ? ShepherdPalette.lineBright : ShepherdPalette.line,
                            lineWidth: 1) }
                    // The closure's own `session` is the target — a right-click does not select the
                    // card, so nothing here may read the selection.
                    .contextMenu { SessionContextMenuItems(session: session, controller: contextMenu) }
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 3, leading: 8, bottom: 3, trailing: 8))
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
                            .modifier(ShepherdMonoFont(label: true))
                            .tracking(1)
                            .foregroundStyle(ShepherdPalette.muted)
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
