import SwiftUI
import Observation
import ShepherdKit

@MainActor struct MergeOwedActions {
    var toggle: @MainActor (String, String, ManualStepToggle) async throws -> Void
    var dismiss: @MainActor (String) async throws -> Void

    static func live(_ client: ShepherdClient) -> Self {
        .init(toggle: { id, stepID, body in
            _ = try await client.setManualStepDone(id: id, stepId: stepID, body: body)
        }, dismiss: { id in
            _ = try await client.dismissManualSteps(id: id)
        })
    }
}

@Observable @MainActor final class MergeOwedState {
    let model: MergeModel
    private let actions: MergeOwedActions
    private(set) var dismissID: String?

    init(model: MergeModel, actions: MergeOwedActions) {
        self.model = model
        self.actions = actions
    }
    func records(repos: Set<String>) -> [PostMergeSteps] {
        MergeRules.owed(model.snapshot.owed, repos: repos)
    }
    func toggle(recordID: String, stepID: String, done: Bool) {
        model.perform { [actions] in
            try await actions.toggle(recordID, stepID, .init(done: done))
        }
    }
    func requestDismiss(_ id: String) { dismissID = id }
    func cancelDismiss() { dismissID = nil }
    func confirmDismiss() {
        guard let id = dismissID else { return }
        // Like the web panel, accept dismissal while a toggle is in flight. Preserve it
        // behind that write so the serial model cannot silently drop the confirmation.
        model.perform(queueIfBusy: true) { [actions] in try await actions.dismiss(id) }
        dismissID = nil
    }
}

struct MergeOwedView: View {
    let model: MergeModel
    var repos: Set<String> = []
    @State private var state: MergeOwedState

    init(model: MergeModel, client: ShepherdClient, repos: Set<String> = []) {
        self.model = model
        self.repos = repos
        _state = State(initialValue: MergeOwedState(model: model, actions: .live(client)))
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(L.t("owed_title")).font(.headline)
                if !model.settled { ProgressView() }
                if let error = model.error { Text(verbatim: error).foregroundStyle(.red) }
                ForEach(state.records(repos: repos), id: \.sessionId) { record in
                    GroupBox {
                        VStack(alignment: .leading) {
                            Text(verbatim: "\(record.desig) · \(record.repoPath) · \(record.prTitle)")
                            if let raw = record.trackingIssueUrl, let url = URL(string: raw),
                                ["http", "https"].contains(url.scheme ?? "") {
                                Link(L.t("owed_tracking_issue"), destination: url)
                            }
                            ForEach(record.steps, id: \.id) { step in
                                Toggle(isOn: Binding(get: { step.doneAt != nil }, set: { done in
                                    state.toggle(recordID: record.sessionId, stepID: step.id, done: done)
                                })) {
                                    HStack {
                                        if step.postMerge { Text(L.t("owed_post_merge_badge")) }
                                        Text(verbatim: step.text).strikethrough(step.doneAt != nil)
                                    }
                                }.disabled(model.busy)
                            }
                            Button(L.t("owed_dismiss")) { state.requestDismiss(record.sessionId) }
                        }
                    }
                }
                if model.settled && model.error == nil && state.records(repos: repos).isEmpty {
                    Text(L.t("owed_empty"))
                }
            }.padding()
        }
        .confirmationDialog(L.t("owed_dismiss_confirm"), isPresented: Binding(
            get: { state.dismissID != nil }, set: { if !$0 { state.cancelDismiss() } })) {
                Button(L.t("owed_dismiss"), role: .destructive) {
                    state.confirmDismiss()
                }
        }
        .accessibilityIdentifier("merge-owed")
    }
}
