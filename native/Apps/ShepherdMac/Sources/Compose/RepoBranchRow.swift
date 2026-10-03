import AppKit
import ShepherdAppCore
import ShepherdKit
import SwiftUI

/// Task 9 supplies the store's repos and binds the four shortcuts to ComposeModel's actions.
struct RepoBranchRow: View {
    @Bindable var model: ComposeModel
    let repos: [Repo]
    let sessions: [Session]
    @FocusState private var editingBase: Bool

    private var visibleRepos: [Repo] { repos.filter { !$0.hidden } }
    private var repoName: String { visibleRepos.first { $0.path == model.repoPath }?.name ?? model.repoPath }
    private func presented(_ picker: RepoBranchModel.Picker) -> Binding<Bool> {
        Binding(get: { model.repoBranches.presentedPicker == picker }, set: { showing in
            if !showing, model.repoBranches.presentedPicker == picker { model.repoBranches.presentedPicker = nil }
        })
    }
    private func repoMenu() -> NSMenu {
        let stamps = RepoRecency.lastUsed(visibleRepos, sessions: sessions)
        return RepoMenu.make(recent: RepoRecency.recent(visibleRepos, sessions: sessions),
                             all: RepoRecency.alphabetical(visibleRepos), selected: model.repoPath,
                             age: { repo in stamps[repo.path].map { RepoRecency.age($0) } },
                             pick: { [model] path in model.repoPath = path })
    }

    var body: some View {
        @Bindable var branch = model.repoBranches
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Button(action: model.openRepoPicker) {
                    HStack {
                        Text(verbatim: L.t("newtask_repo_label"))
                        Text(verbatim: repoName).lineLimit(1)
                        Image(systemName: "chevron.down")
                    }
                }
                .accessibilityLabel(L.t("newtask_repo_label"))
                .accessibilityIdentifier("compose.repo")
                .background(RepoMenuAnchor(presented: branch.presentedPicker == .repo, menu: repoMenu,
                                           closed: { presented(.repo).wrappedValue = false }))
                Text(verbatim: L.t("newtask_chip_from")).foregroundStyle(.secondary)
                Button(action: model.openBranchPicker) {
                    HStack {
                        Text(verbatim: branch.baseBranch)
                        Image(systemName: "chevron.down")
                    }
                }
                .accessibilityLabel(L.t("newtask_branch_label"))
                .accessibilityIdentifier("compose.branch")
                .popover(isPresented: presented(.branch)) {
                    VStack(alignment: .leading) {
                        if branch.branches.isEmpty {
                            TextField(L.t("newtask_branch_label"), text: $branch.baseBranch,
                                      prompt: Text(verbatim: L.t("newtask_branch_placeholder")))
                                .focused($editingBase)
                        .focusedValue(\.composeEditingText, true)
                                .onAppear { editingBase = true }
                                .onSubmit { branch.presentedPicker = nil }
                        } else {
                            ScrollView {
                                VStack(alignment: .leading) {
                                    ForEach(branch.baseOptions, id: \.self) { name in
                                        Button {
                                            branch.baseBranch = name
                                            branch.presentedPicker = nil
                                        } label: {
                                            Text(verbatim: name).frame(maxWidth: .infinity, alignment: .leading)
                                        }
                                    }
                                }
                            }.frame(maxHeight: 300)
                        }
                    }.padding().frame(minWidth: 240)
                }
            }
            .disabled(branch.repairingBase)
            if branch.upstreamLoading {
                Text(verbatim: L.t("newtask_upstream_checking")).foregroundStyle(.secondary)
            } else if let status = branch.upstream, status.diverged {
                Text(verbatim: L.t("newtask_upstream_diverged", String(status.behind), String(status.ahead), branch.baseBranch))
                    .foregroundStyle(.orange)
            } else if let status = branch.upstream, status.behind > 0 {
                Text(verbatim: L.t("newtask_upstream_behind", String(status.behind)))
                    .foregroundStyle(.secondary)
            }
            if branch.baseMissing {
                Text(verbatim: L.t("newtask_readiness_base_missing"))
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("compose.baseMissing")
                Text(verbatim: L.t("newtask_base_missing")).foregroundStyle(.secondary)
                Button(L.t("newtask_init_commit")) { Task { await branch.repairInitialCommit() } }
                    .accessibilityIdentifier("compose.repairBase")
                    .disabled(branch.repairingBase)
            }
            if branch.repairingBase {
                Text(verbatim: L.t("newtask_init_commit_running")).foregroundStyle(.secondary)
            }
            if let error = branch.error {
                Text(verbatim: error).foregroundStyle(.red)
            }
        }
    }
}
