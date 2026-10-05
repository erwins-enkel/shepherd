import SwiftUI
import UIKit
import ShepherdAppCore
import ShepherdKit

/// The only confirmation a decommission gets: the archive removes the worktree and cannot be
/// undone, so the sheet says what happens to an open PR and which leftovers end with it.
struct IOSDecommissionSheet: View {
    let session: Session
    @Bindable var state: IOSSessionActionState
    @State private var clock = Date()
    @AccessibilityFocusState private var cancelFocused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                IOSDecommissionContent(session: session, state: state, clock: clock).padding(16)
            }
            .sessionFont().foregroundStyle(SessionListStyle.ink).background(SessionListStyle.background)
            .navigationTitle(L.t("cardmenu_decommission")).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) {
                Button(L.t("common_cancel"), action: state.dismiss)
                    .disabled(state.busy).accessibilityFocused($cancelFocused)
                    .accessibilityIdentifier("decommission-cancel")
            } }
        }
        .interactiveDismissDisabled(state.busy)
        .preferredColorScheme(.dark).tint(SessionListStyle.amber)
        .task(id: state.presentedAt) {
            cancelFocused = true
            clock = Date()
            // Same arming as the merge sheet; confirmDecommission checks the timestamp too.
            do { try await Task.sleep(for: .milliseconds(350)); clock = Date() }
            catch { return }
        }
    }
}

struct IOSDecommissionContent: View {
    let session: Session
    @Bindable var state: IOSSessionActionState
    var clock = Date()

    var body: some View {
        let draft = state.decommission
        VStack(alignment: .leading, spacing: 16) {
            if draft.asksAboutPR {
                Text(verbatim: L.t("decommission_pr_title", String(draft.git?.number ?? 0)))
                    .sessionFont(label: true, weight: .semibold).foregroundStyle(SessionListStyle.muted)
                Text(verbatim: L.t("decommission_pr_desc", session.name)).fixedSize(horizontal: false, vertical: true)
            } else {
                Text(verbatim: L.t("native_archive_confirm_body")).fixedSize(horizontal: false, vertical: true)
            }
            if draft.loaded {
                if draft.choices.contains(.merge) { IOSMergeGateNotice(git: draft.git) }
                leftovers(draft)
            } else {
                ProgressView().frame(maxWidth: .infinity).accessibilityLabel(L.t("common_loading"))
            }
            IOSActionFeedback(error: state.error, busy: state.busy)
            // Until the PR is read, the choices are unknown: show none rather than the wrong ones.
            if draft.loaded {
                ForEach(draft.choices) { choice in
                    Button {
                        Task {
                            if await state.confirmDecommission(choice) {
                                UINotificationFeedbackGenerator().notificationOccurred(.success)
                            }
                        }
                    } label: {
                        Text(verbatim: title(choice, draft)).frame(maxWidth: .infinity).fixedSize(horizontal: false, vertical: true)
                    }
                    .buttonStyle(IOSActionButtonStyle(tint: isDestructive(choice, draft) ? SessionListStyle.red : SessionListStyle.amber))
                    .disabled(!state.canConfirmDecommission(choice, now: clock))
                    .accessibilityIdentifier("decommission-\(choice.id)")
                }
            }
        }.disabled(state.busy).sessionFont().foregroundStyle(SessionListStyle.ink)
    }

    @ViewBuilder private func leftovers(_ draft: IOSDecommissionDraft) -> some View {
        if draft.probesUnavailable {
            Label(L.t("native_compose_probes_unavailable"), systemImage: "exclamationmark.triangle")
                .foregroundStyle(SessionListStyle.amber).fixedSize(horizontal: false, vertical: true)
        }
        if !draft.leftovers.isEmpty {
            Text(verbatim: L.t("leftover_title")).sessionFont(label: true, weight: .semibold)
            Text(verbatim: L.t("leftover_desc")).foregroundStyle(SessionListStyle.muted)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(draft.leftovers, id: \.key) { item in
                Toggle(isOn: Binding(get: { state.decommission.reap.contains(item.key) }, set: { selected in
                    if selected { state.decommission.reap.insert(item.key) } else { state.decommission.reap.remove(item.key) }
                })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: item.name)
                        if let port = item.port {
                            Text(verbatim: L.t("leftover_port", String(port))).foregroundStyle(SessionListStyle.muted)
                        }
                    }
                }
                .frame(minHeight: 44)
                .accessibilityIdentifier("decommission-leftover-\(item.key)")
            }
        }
    }

    private func title(_ choice: IOSDecommissionChoice, _ draft: IOSDecommissionDraft) -> String {
        switch choice {
        case .keep: L.t(draft.asksAboutPR ? "decommission_pr_keep" : "cardmenu_decommission")
        case .merge:
            L.t(IOSMergeConfirmationFacts.isTakeover(draft.git) ? "decommission_pr_merge_takeover" : "decommission_pr_merge")
        case .close: L.t("decommission_pr_close")
        }
    }

    /// Keeping the PR is the web dialog's primary choice; without a PR the one button just ends it.
    private func isDestructive(_ choice: IOSDecommissionChoice, _ draft: IOSDecommissionDraft) -> Bool {
        choice == .close || (choice == .keep && !draft.asksAboutPR)
    }
}
