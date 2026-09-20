import ShepherdKit
import SwiftUI

/// Optional overrides preserve the server's inheritance for fields the operator did not edit.
struct RelaunchOptionsView: View {
    let session: Session
    let repos: [Repo]
    let confirm: (RelaunchRequest) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var repo = ""
    @State private var branch = ""
    @State private var prompt = ""

    static func request(session: Session, repo: String, branch: String, prompt: String) -> RelaunchRequest {
        .init(repoPath: repo == session.repoPath ? nil : repo,
              baseBranch: branch == session.baseBranch ? nil : branch,
              prompt: prompt == session.prompt ? nil : prompt)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(L.t("native_actions_relaunch_confirm_title")).font(.headline)
            Text(L.t("native_actions_relaunch_confirm_body"))
            Picker(L.t("newtask_repo_label"), selection: $repo) {
                ForEach(repos.filter { !$0.hidden || $0.path == session.repoPath }, id: \.path) { repo in
                    Text(verbatim: repo.name).tag(repo.path)
                }
            }
            TextField(L.t("newtask_branch_label"), text: $branch)
            TextEditor(text: $prompt).frame(height: 180)
                .accessibilityLabel(L.t("newtask_prompt_label"))
            HStack {
                Button(L.t("common_cancel")) { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button(L.t("native_actions_relaunch_confirm_action"), role: .destructive) {
                    confirm(Self.request(session: session, repo: repo, branch: branch, prompt: prompt))
                }.disabled(repo.isEmpty || branch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || prompt.count > 8000)
            }
        }.padding(24).frame(width: 600)
        .onAppear { repo = session.repoPath; branch = session.baseBranch; prompt = session.prompt }
    }
}
