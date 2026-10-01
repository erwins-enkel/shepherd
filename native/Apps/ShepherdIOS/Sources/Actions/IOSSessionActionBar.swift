import SwiftUI
import ShepherdAppCore
import ShepherdKit

/// Thin insertion in detail; presentation resets with the activation/session.
struct IOSSessionActionBar: View {
    let session: Session
    @Environment(AppModel.self) private var app
    var body: some View {
        if let controller = app.extension(IOSSessionActions.self), let store = app.store {
            IOSSessionActionBarContent(session: session, state: controller.state(for: session),
                recap: app.extension(ActionsModel.self)?.recap(for: session.id), repos: store.repos,
                canMerge: controller.state(for: session).canMerge(session, git: MergeInputs.git(app),
                    reviewing: MergeInputs.reviewing(app, session.id)))
                .id("\(app.activationGeneration):\(session.id)")
                .onAppear {
                    if let note = app.extension(ActionsModel.self)?.consumeOutcomeNote(forSessionID: session.id) {
                        controller.state(for: session).outcome.note = .success(note)
                    }
                }
        }
    }
}

struct IOSSessionActionBarContent: View {
    let session: Session
    @Bindable var state: IOSSessionActionState
    let recap: Recap?
    let repos: [Repo]
    let canMerge: Bool
    var rendersStaticFixture = false
    @State private var showsRecap = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            IOSActionFeedback(error: state.error, note: state.outcome.note, busy: state.busy, rendersStaticFixture: rendersStaticFixture)
            if let recap {
                Button { showsRecap = true } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Image(systemName: "text.alignleft").accessibilityHidden(true)
                        Text(verbatim: RecapLine.content(for: recap)?.headline ?? recapStatus(recap))
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.up").accessibilityHidden(true)
                    }.frame(minHeight: 44)
                }
                .buttonStyle(.plain).foregroundStyle(SessionListStyle.muted)
                .accessibilityLabel(L.t("feat_visual_recap_title"))
                .accessibilityValue(recap.headline)
                .accessibilityIdentifier("actions-recap")
            }
            if session.status.known != .archived {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { primaryButtons; moreMenu }
                    VStack(alignment: .leading, spacing: 8) { primaryButtons; moreMenu }
                }
                if !state.allowsWrites {
                    Text(L.t("native_ios_actions_read_only")).foregroundStyle(SessionListStyle.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .sessionFont()
        .foregroundStyle(SessionListStyle.ink).padding(.horizontal, 12).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(SessionListStyle.panel)
        .overlay(alignment: .top) { Rectangle().fill(SessionListStyle.brightLine).frame(height: 1) }
        .tint(SessionListStyle.amber).preferredColorScheme(.dark)
        .accessibilityElement(children: .contain).accessibilityLabel(L.t("native_actions_bar_label"))
        .accessibilityIdentifier("session-actions")
        .sheet(item: $state.sheet) { sheet in
            if sheet == .merge { IOSMergeConfirmationSheet(session: session, state: state) }
            else { IOSActionEditorSheet(session: session, state: state, repos: repos, kind: sheet) }
        }
        .sheet(isPresented: $showsRecap) { IOSRecapSheet(recap: recap) }
        .onDisappear { state.detailDidDisappear() }
    }

    @ViewBuilder private var primaryButtons: some View {
        ForEach(state.swipeActions.filter { !canMerge || $0 != .toggleReady }) { action in
            Button { Task { await state.execute(action) } } label: {
                Label(IOSSessionActionState.label(action, session: session), systemImage: action.systemImage)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .buttonStyle(IOSActionButtonStyle())
            .disabled(state.busy || !state.allowsWrites)
            .accessibilityHint(action.help(for: session))
            .accessibilityIdentifier("action-\(action.id)")
        }
        if canMerge {
            Button(action: state.prepareMerge) {
                Label(L.t("prbadge_merge"), systemImage: "arrow.triangle.merge")
                    .fixedSize(horizontal: false, vertical: true)
            }
            .buttonStyle(IOSActionButtonStyle())
            .disabled(state.busy || !state.allowsWrites)
            .accessibilityIdentifier("action-merge")
            .disabled(state.mergeModel.busy)
        }
    }

    @ViewBuilder private var moreMenu: some View {
        if rendersStaticFixture { moreMenuLabel }
        else { Menu {
            ForEach(state.actions) { action in
                Button(role: action == .relaunch ? .destructive : nil) {
                    switch action {
                    case .rename, .amend, .relaunch: state.present(action)
                    default: Task { await state.execute(action) }
                    }
                } label: {
                    Label(IOSSessionActionState.label(action, session: session), systemImage: action.systemImage)
                }
                .accessibilityHint(action.help(for: session))
                .accessibilityIdentifier("menu-action-\(action.id)")
            }
        } label: {
            moreMenuLabel
        }
        .disabled(state.busy || !state.allowsWrites || state.actions.isEmpty)
        .accessibilityLabel(L.t("cardmenu_label"))
        .accessibilityIdentifier("actions-menu")
        }
    }

    private var moreMenuLabel: some View {
        Label(L.t("cardmenu_label"), systemImage: "ellipsis")
            .labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44)
    }

    private func recapStatus(_ recap: Recap) -> String {
        switch recap.state.known {
        case .generating: L.t("recap_generating")
        case .failed: L.t("recap_failed")
        default: L.t("recap_unavailable")
        }
    }
}

struct IOSActionFeedback: View {
    var error: String?
    var note: ActionNote?
    var busy = false
    var rendersStaticFixture = false
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if busy {
                HStack(spacing: 8) {
                    if rendersStaticFixture { Image(systemName: "hourglass").accessibilityHidden(true) }
                    else { ProgressView() }
                    Text(L.t("common_loading"))
                }
                    .foregroundStyle(SessionListStyle.muted).accessibilityIdentifier("actions-progress")
            }
            if let error {
                Label(error, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(SessionListStyle.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("actions-error")
            }
            if let note {
                Label(note.text, systemImage: note.tone.systemImage)
                    .foregroundStyle(note.tone == .warning ? SessionListStyle.amber : SessionListStyle.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("actions-note")
            }
        }.sessionFont().accessibilityElement(children: .contain)
    }
}

struct IOSActionButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.sessionFont(label: true, weight: .semibold)
            .foregroundStyle(isEnabled ? SessionListStyle.amber : SessionListStyle.muted)
            .padding(.horizontal, 10).padding(.vertical, 8).frame(minHeight: 44)
            .background(configuration.isPressed ? SessionListStyle.selected : SessionListStyle.background)
            .overlay { RoundedRectangle(cornerRadius: 2).stroke(isEnabled ? SessionListStyle.amber : SessionListStyle.brightLine, lineWidth: 1) }
    }
}
