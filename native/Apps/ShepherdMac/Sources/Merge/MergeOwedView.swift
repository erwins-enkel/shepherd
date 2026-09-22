import ShepherdAppCore
import SwiftUI
import Observation
import ShepherdKit

struct MergeOwedView: View {
    let model: MergeModel
    var repos: Set<String> = []
    @State private var state: MergeOwedState

    init(model: MergeModel, client: ShepherdClient, repos: Set<String> = []) {
        self.init(state: MergeOwedState(model: model, actions: .live(client)), repos: repos)
    }
    init(state: MergeOwedState, repos: Set<String> = []) {
        self.model = state.model
        self.repos = repos
        _state = State(initialValue: state)
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
