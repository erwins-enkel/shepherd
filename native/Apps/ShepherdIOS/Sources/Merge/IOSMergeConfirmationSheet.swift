import SwiftUI
import ShepherdAppCore
import ShepherdKit

struct IOSMergeConfirmationSheet: View {
    let session: Session
    @Bindable var state: IOSSessionActionState
    @State private var clock = Date()
    @AccessibilityFocusState private var cancelFocused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                IOSMergeConfirmationContent(session: session, state: state, clock: clock).padding(16)
            }
            .sessionFont().foregroundStyle(SessionListStyle.ink).background(SessionListStyle.background)
            .navigationTitle(L.t("prbadge_merge")).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) {
                Button(L.t("common_cancel"), action: state.dismiss)
                    .disabled(state.busy).accessibilityFocused($cancelFocused)
                    .accessibilityIdentifier("merge-cancel")
            } }
        }
        .interactiveDismissDisabled(state.busy)
        .preferredColorScheme(.dark).tint(SessionListStyle.amber)
        .task(id: state.presentedAt) {
            cancelFocused = true
            clock = Date()
            // Production arming delay matches mobile web and Mac. The timestamp is
            // also checked by confirmMerge; a stale rendered enabled button cannot act.
            do { try await Task.sleep(for: .milliseconds(350)); clock = Date() }
            catch { return }
        }
    }
}

struct IOSMergeConfirmationContent: View {
    let session: Session
    @Bindable var state: IOSSessionActionState
    var clock = Date()
    var rendersStaticFixture = false
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            IOSMergeConfirmationFacts(session: session, git: state.candidate, method: state.method)
            if rendersStaticFixture {
                Label(L.t("native_merge_delete_branch"), systemImage: state.deleteBranch ? "checkmark.square" : "square")
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Picker(L.t("native_merge_method"), selection: $state.method) {
                    Text(L.t("native_ios_actions_server_default")).tag(Optional<MergeMethod>.none)
                    ForEach([MergeMethod.squash, .merge, .rebase], id: \.self) { method in
                        Text(verbatim: method.rawValue).tag(Optional(method))
                    }
                }.pickerStyle(.menu).frame(minHeight: 44).accessibilityIdentifier("merge-method")
                Toggle(L.t("native_merge_delete_branch"), isOn: $state.deleteBranch).frame(minHeight: 44)
            }
            IOSActionFeedback(error: state.error, busy: state.busy, rendersStaticFixture: rendersStaticFixture)
            Button(action: { state.confirmMerge() }) {
                Text(verbatim: IOSMergeConfirmationFacts.confirmTitle(state.candidate))
                    .frame(maxWidth: .infinity).fixedSize(horizontal: false, vertical: true)
            }
            .buttonStyle(IOSActionButtonStyle())
            .disabled(!state.canConfirmMerge(now: clock))
            .accessibilityIdentifier("merge-confirm")
        }.disabled(state.busy).sessionFont().foregroundStyle(SessionListStyle.ink)
    }
}

struct IOSMergeConfirmationFacts: View {
    let session: Session
    let git: GitState?
    let method: MergeMethod?
    static func confirmTitle(_ git: GitState?) -> String {
        let takeover = git?.mergeGate?.handoff != nil || git?.mergeGate?.reviewBlockBy != nil
        return L.t(takeover ? "mergeconfirm_confirm_takeover" : "mergeconfirm_confirm")
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(L.t("mergeconfirm_eyebrow")).foregroundStyle(SessionListStyle.muted)
            fact(L.t("mergeconfirm_field_repo"), session.repoPath)
            fact(L.t("mergeconfirm_field_pr"), "#\(git?.number ?? 0) \(git?.title ?? session.name)")
            fact(L.t("mergeconfirm_field_target"), git?.baseRefName ?? L.t("mergeconfirm_value_unknown"))
            fact(L.t("mergeconfirm_field_method"), method?.rawValue ?? L.t("native_ios_actions_server_default"))
            fact(L.t("native_ios_actions_revision"), git?.headSha ?? L.t("mergeconfirm_value_unknown"))
            if let gate = git?.mergeGate {
                if let who = gate.handoffWho {
                    Text(verbatim: gate.handoff?.known == .reviewer
                        ? L.t("mergeconfirm_handoff_reviewer", who) : L.t("mergeconfirm_handoff_merger", who))
                        .foregroundStyle(SessionListStyle.amber).fixedSize(horizontal: false, vertical: true)
                }
                if let reviewer = gate.reviewBlockBy {
                    Text(L.t("mergeconfirm_review_block", reviewer)).foregroundStyle(SessionListStyle.amber)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }.sessionFont().foregroundStyle(SessionListStyle.ink)
    }
    private func fact(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(verbatim: label.uppercased()).sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
            Text(verbatim: value).fixedSize(horizontal: false, vertical: true)
        }.accessibilityElement(children: .combine)
    }
}
