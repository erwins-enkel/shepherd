import ShepherdAppCore
import ShepherdKit
import SwiftUI

struct ComposeLeftColumn: View {
    let app: AppModel
    @Bindable var model: ComposeModel
    let repos: [Repo]
    let sessions: [Session]
    @Binding var serverPickerOpen: Bool
    let editSteers: (Issue) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if app.profiles.count > 1 {
                ComposeServerPicker(app: app, prompt: model.prompt, presented: $serverPickerOpen)
                    .modifier(ComposeKeycap(ids: ["server"]))
            }
            RepoBranchRow(model: model, repos: repos, sessions: sessions)
            ComposePromptEditor(model: model)
                .modifier(ComposeKeycap(ids: ["focus-prompt", "issue-token", "command-token", "paste-image"]))
            ShapeRoundView(model: model)
            IssuePickerView(model: model, editSteers: editSteers)
                .modifier(ComposeKeycap(ids: ["issue-filter", "sources-tab"]))
                .padding(12).background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
        }
    }
}
