import SwiftUI
import ShepherdAppCore
import ShepherdKit

struct SessionDetailView: View {
    let session: Session
    let model: DetailModel
    var body: some View {
        List {
            Section {
                LabeledContent(L.t("native_detail_status_label"), value: SessionStatusStyle.label(session.status))
                Text(verbatim: session.desig).font(.caption.monospaced())
                Text(verbatim: session.repoPath).font(.callout).textSelection(.enabled)
                Text(verbatim: session.branch).font(.callout.monospaced()).textSelection(.enabled)
            }
            Section(L.t("newtask_prompt_label")) {
                Text(verbatim: session.prompt).textSelection(.enabled)
            }
            ActivityView(session: session, model: model)
        }
        .navigationTitle(session.name)
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("session-detail")
    }
}
