import SwiftUI
import ShepherdKit

struct MergeOwedView: View {
    let model: MergeModel
    let client: ShepherdClient
    var repos: Set<String> = []
    @State private var dismissID: String?
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(L.t("owed_title")).font(.headline)
                if !model.settled { ProgressView() }
                if let error = model.error { Text(verbatim: error).foregroundStyle(.red) }
                ForEach(MergeRules.owed(model.snapshot.owed, repos: repos), id: \.sessionId) { record in
                    GroupBox {
                        VStack(alignment: .leading) {
                            Text(verbatim: "\(record.desig) · \(record.repoPath) · \(record.prTitle)")
                            if let raw = record.trackingIssueUrl, let url = URL(string: raw),
                                ["http", "https"].contains(url.scheme ?? "") {
                                Link(L.t("owed_tracking_issue"), destination: url)
                            }
                            ForEach(record.steps, id: \.id) { step in
                                Toggle(isOn: Binding(get: { step.doneAt != nil }, set: { done in
                                    model.perform { _ = try await client.setManualStepDone(
                                        id: record.sessionId, stepId: step.id, body: .init(done: done)) }
                                })) {
                                    HStack {
                                        if step.postMerge { Text(L.t("owed_post_merge_badge")) }
                                        Text(verbatim: step.text).strikethrough(step.doneAt != nil)
                                    }
                                }.disabled(model.busy)
                            }
                            Button(L.t("owed_dismiss")) { dismissID = record.sessionId }
                        }
                    }
                }
                if model.settled && model.error == nil && MergeRules.owed(model.snapshot.owed, repos: repos).isEmpty {
                    Text(L.t("owed_empty"))
                }
            }.padding()
        }
        .confirmationDialog(L.t("owed_dismiss_confirm"), isPresented: Binding(
            get: { dismissID != nil }, set: { if !$0 { dismissID = nil } })) {
                Button(L.t("owed_dismiss"), role: .destructive) {
                    guard let id = dismissID else { return }
                    dismissID = nil
                    model.perform { _ = try await client.dismissManualSteps(id: id) }
                }
        }
        .accessibilityIdentifier("merge-owed")
    }
}
