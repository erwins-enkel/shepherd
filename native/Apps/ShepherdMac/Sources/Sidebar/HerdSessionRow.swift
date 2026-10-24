import ShepherdAppCore
import ShepherdKit
import SwiftUI

/// The same card and actions for a session here or on a connected machine.
struct HerdSessionRow: View {
    @Environment(AppModel.self) private var app
    let session: Session
    let now: Int
    let display: (Session) -> Session
    let block: (String) -> BlockReason?
    let showCli: Bool
    let contextMenu: SessionContextController

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            let sidebar = app.extension(SidebarModel.self)
            let plan = app.extension(PlanModel.self)
            let content = SessionRowContent(session: session,
                activity: app.extension(HerdSignals.self)?.activity[session.id],
                hold: sidebar?.hold(for: session.id), gate: plan?.gates[session.id],
                planReviewing: plan?.reviewing.contains(session.id) ?? false,
                recap: app.extension(ActionsModel.self)?.recap(for: session.id),
                now: now)
            HStack(alignment: .top, spacing: 4) {
                SessionRow(session: display(session), content: content,
                    onRepoFilter: { sidebar?.toggleRepo(session.repoPath, additive: false) },
                    repoFiltered: sidebar?.activeRepos == [session.repoPath])
                    .modifier(SettingsStatusShape(status: display(session).status))
                Menu {
                    SessionContextMenuItems(session: session, controller: contextMenu)
                } label: {
                    Label(L.t("cardmenu_label"), systemImage: "ellipsis")
                        .labelStyle(.iconOnly)
                }
                .menuStyle(.button)
                .buttonStyle(.plain)
                .menuIndicator(.hidden)
                .frame(width: 20, height: 22)
                .help(L.t("cardmenu_label"))
                .accessibilityLabel(L.t("cardmenu_label"))
                .accessibilityIdentifier("session-menu-\(session.id)")
            }
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
            HerdRowSignals(session: session, block: block(session.id), showCli: showCli, contextMenu: contextMenu)
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
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("herd-session-\(session.id)")
        .tag(session.id)
    }
}
