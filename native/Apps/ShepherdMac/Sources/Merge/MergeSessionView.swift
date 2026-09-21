import ShepherdAppCore
import SwiftUI
import ShepherdKit

struct MergeSessionView: View {
    let app: AppModel
    let session: Session
    let store: SessionStore
    let model: MergeModel
    var body: some View {
        MergeSessionContent(app: app, session: session, store: store, model: model)
            .id("\(app.activationGeneration):\(session.id)")
    }
}

// Keep presentation state below the activation/session identity, including before tab registration.
private struct MergeSessionContent: View {
    let app: AppModel
    let session: Session
    let store: SessionStore
    let model: MergeModel
    @State private var method: MergeMethod = .squash
    @State private var deleteBranch = true
    @State private var confirm = false
    @State private var candidate: GitState?
    @State private var redeploy = false
    @State private var armed = false
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(verbatim: session.name).font(.headline)
            if let error = model.error { Text(verbatim: error).foregroundStyle(.red) }
            automation(L.t("native_merge_autopilot"), value: session.autopilotEnabled) { value in
                model.perform { _ = try await store.client.setSessionAutopilot(id: session.id, body: .value(value)) }
            }
            automation(L.t("native_merge_automerge"), value: session.autoMergeEnabled) { value in
                model.perform { _ = try await store.client.setSessionAutomerge(id: session.id, body: .value(value)) }
            }
            if session.autopilotPaused { Text(L.t("native_merge_paused")) }
            if session.autopilotComplete { Text(L.t("native_merge_complete")) }
            Picker(L.t("native_merge_method"), selection: $method) {
                Text(verbatim: MergeMethod.squash.rawValue).tag(MergeMethod.squash)
                Text(verbatim: MergeMethod.merge.rawValue).tag(MergeMethod.merge)
                Text(verbatim: MergeMethod.rebase.rawValue).tag(MergeMethod.rebase)
            }
            Toggle(L.t("native_merge_delete_branch"), isOn: $deleteBranch)
            Button(L.t("mergeconfirm_confirm")) {
                candidate = nil; armed = false
                model.perform(commit: { git in
                    guard let git, git.state.known == .open, git.number != nil else { return }
                    candidate = git; confirm = true
                }) { try await store.client.git(sessionID: session.id) }
            }
            Button(L.t("native_merge_redeploy")) { redeploy = true }
            // Session's core contract exposes these rows as generated open objects.
            ForEach(session.manualSteps.indices, id: \.self) { index in
                if let text = session.manualSteps[index].additionalProperties.value["text"] as? String {
                    Text(verbatim: text)
                }
            }
            Button(L.t("native_merge_ack")) {
                model.perform { _ = try await store.client.ackManualSteps(id: session.id) }
            }.disabled(session.manualSteps.isEmpty)
            MergeQueueView(app: app, session: session, store: store, model: model)
        }
        .padding().disabled(model.busy)
        .sheet(isPresented: $confirm) {
            VStack(alignment: .leading, spacing: 12) {
                Text(verbatim: "#\(candidate?.number ?? 0) \(candidate?.title ?? session.name)")
                Text(verbatim: candidate?.baseRefName ?? "—")
                Text(verbatim: candidate?.headSha ?? "—")
                Text(verbatim: method.rawValue)
                if let gate = candidate?.mergeGate {
                    if let who = gate.handoffWho {
                        Text(gate.handoff?.known == .reviewer
                            ? L.t("mergeconfirm_handoff_reviewer", who)
                            : L.t("mergeconfirm_handoff_merger", who))
                    }
                    if let reviewer = gate.reviewBlockBy { Text(L.t("mergeconfirm_review_block", reviewer)) }
                }
                Toggle(L.t("native_merge_delete_branch"), isOn: $deleteBranch)
                if let error = model.error { Text(verbatim: error).foregroundStyle(.red) }
                HStack {
                    Button(L.t("common_cancel")) { confirm = false }.keyboardShortcut(.cancelAction)
                    Button(L.t("mergeconfirm_confirm")) {
                        guard armed, !model.busy, let candidate,
                            candidate.mergeGate?.handoff == nil || candidate.mergeGate?.handoff?.known != nil else { return }
                        let payload = MergeConfirmationRules.payload(candidate)
                        armed = false
                        model.perform(commit: { _ in confirm = false; self.candidate = nil },
                            failure: { confirm = false; self.candidate = nil }) {
                            try await store.client.mergePR(sessionID: session.id,
                                method: method, deleteBranch: deleteBranch, confirm: payload)
                        }
                    }.disabled(!armed || model.busy || candidate == nil
                        || (candidate?.mergeGate?.handoff != nil && candidate?.mergeGate?.handoff?.known == nil))
                }
            }.padding().task {
                armed = false
                do { try await Task.sleep(for: .milliseconds(350)); armed = true }
                catch { armed = false }
            }
        }
        .confirmationDialog(L.t("native_merge_redeploy"), isPresented: $redeploy) {
            Button(L.t("native_merge_redeploy")) {
                model.perform { _ = try await store.client.redeploySession(id: session.id) }
            }
        }
        .accessibilityIdentifier("detail-tab-merge")
    }
    private func automation(_ title: String, value: Bool?, change: @escaping (Bool?) -> Void) -> some View {
        Picker(title, selection: Binding(get: { value.map { $0 ? 1 : 0 } ?? -1 }, set: {
            change($0 == -1 ? nil : $0 == 1)
        })) {
            Text(L.t("native_merge_inherit")).tag(-1)
            Text(L.t("native_merge_off")).tag(0)
            Text(L.t("native_merge_on")).tag(1)
        }
    }
}
