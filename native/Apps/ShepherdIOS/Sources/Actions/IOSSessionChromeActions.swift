import SwiftUI
import ShepherdAppCore
import ShepherdKit

/// All detail command entry points share one state; only the persistent header
/// owns command sheets, so switching tabs cannot dismiss a pending command.
struct IOSSessionChromeActions: View {
    enum Placement { case menu, inline, recap }
    let session: Session
    let placement: Placement
    @Environment(AppModel.self) private var app
    var body: some View {
        if let controller = app.extension(IOSSessionActions.self), let store = app.store {
            let state = controller.state(for: session)
            IOSSessionChromeActionContent(session: session, state: state, repos: store.repos,
                recap: app.extension(ActionsModel.self)?.recap(for: session.id),
                canMerge: state.canMerge(session, git: MergeInputs.git(app), reviewing: MergeInputs.reviewing(app, session.id)),
                placement: placement)
            .onAppear {
                if placement == .menu, let note = app.extension(ActionsModel.self)?.consumeOutcomeNote(forSessionID: session.id) {
                    state.outcome.note = .success(note)
                }
            }
        }
    }
}

@MainActor
enum IOSSessionHeaderActions {
    /// Same source as the old rail's menu, including editor and archived actions.
    static func actions(_ state: IOSSessionActionState) -> [SessionAction] { state.actions }
}

struct IOSSessionChromeActionContent: View {
    let session: Session
    @Bindable var state: IOSSessionActionState
    let repos: [Repo]
    let recap: Recap?
    let canMerge: Bool
    let placement: IOSSessionChromeActions.Placement
    @State private var showsRecap = false

    var body: some View {
        switch placement {
        case .menu:
            menu
                .sheet(item: $state.sheet) { sheet in
                    if sheet == .merge { IOSMergeConfirmationSheet(session: session, state: state) }
                    else { IOSActionEditorSheet(session: session, state: state, repos: repos, kind: sheet) }
                }
                .onDisappear { state.detailDidDisappear() }
        case .inline:
            if state.busy || state.error != nil || state.outcome.note != nil || !state.allowsWrites || primaryReady || canMerge {
                VStack(alignment: .leading, spacing: 2) {
                    IOSActionFeedback(error: state.error, note: state.outcome.note, busy: state.busy)
                    if !state.allowsWrites {
                        Text(L.t("native_ios_actions_read_only")).foregroundStyle(SessionListStyle.muted)
                    } else if canMerge {
                        Button(action: state.prepareMerge) { Label(L.t("prbadge_merge"), systemImage: "arrow.triangle.merge").frame(minHeight: 44) }
                            .disabled(state.busy || state.mergeModel.busy).accessibilityIdentifier("action-merge")
                    } else if primaryReady {
                        Button { Task { await state.execute(.toggleReady) } } label: {
                            Label(IOSSessionActionState.label(.toggleReady, session: session), systemImage: SessionAction.toggleReady.systemImage)
                                .frame(minHeight: 44)
                        }.disabled(state.busy).accessibilityIdentifier("action-toggleReady")
                    }
                }
                .font(.system(.caption)).buttonStyle(.plain).tint(SessionListStyle.amber)
                .padding(.horizontal, 12).padding(.vertical, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        case .recap:
            if let recap {
                Button { showsRecap = true } label: {
                    HStack {
                        Image(systemName: "text.alignleft")
                        Text(verbatim: RecapLine.content(for: recap)?.headline ?? L.t("feat_visual_recap_title"))
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.up")
                    }.frame(minHeight: 44)
                }.buttonStyle(.plain)
                    .accessibilityLabel(L.t("feat_visual_recap_title"))
                    .accessibilityIdentifier("actions-recap")
                    .sheet(isPresented: $showsRecap) { IOSRecapSheet(recap: recap) }
            }
        }
    }
    private var primaryReady: Bool { state.swipeActions.contains(.toggleReady) }
    private var menu: some View {
        Menu {
            if canMerge {
                Button(L.t("prbadge_merge"), systemImage: "arrow.triangle.merge", action: state.prepareMerge)
                    .disabled(state.busy || !state.allowsWrites || state.mergeModel.busy)
            }
            ForEach(IOSSessionHeaderActions.actions(state)) { action in
                Button(role: action == .relaunch ? .destructive : nil) {
                    switch action {
                    case .rename, .amend, .relaunch: state.present(action)
                    default: Task { await state.execute(action) }
                    }
                } label: { Label(IOSSessionActionState.label(action, session: session), systemImage: action.systemImage) }
                    .disabled(state.busy || !state.allowsWrites)
                    .accessibilityHint(action.help(for: session))
                    .accessibilityIdentifier("menu-action-\(action.id)")
            }
            if !state.allowsWrites { Text(L.t("native_ios_actions_read_only")) }
        } label: { Image(systemName: "ellipsis").frame(width: 44, height: 44) }
            .buttonStyle(.plain).foregroundStyle(SessionListStyle.ink)
            .accessibilityLabel(L.t("cardmenu_label"))
            .accessibilityIdentifier("actions-menu")
    }
}
