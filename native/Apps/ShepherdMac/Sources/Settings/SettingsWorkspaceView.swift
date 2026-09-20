import SwiftUI
import ShepherdKit

struct SettingsWorkspaceView: View {
    let model: SettingsModel
    let client: ShepherdClient
    var body: some View {
        @Bindable var model = model
        Form {
            if let error = model.error { Text(verbatim:error).foregroundStyle(.red) }
            Picker(L.t("native_settings_repo"), selection:Binding(get:{model.repo},set:{model.selectRepo($0,client:client)})) {
                Text(L.t("native_settings_select_repo")).tag("")
                ForEach(model.snapshot?.repos ?? [],id:\.path) { Text(verbatim:$0.display).tag($0.path) }
            }
            if let config = model.repoConfig {
                SettingsRepoFields(config:config) { patch, commit in
                    model.requestWorkspaceAction("config", config: patch, configCommit: commit)
                }
            }
            if model.roles != nil {
                TextField(L.t("native_settings_reviewer"),text:$model.reviewer)
                TextField(L.t("native_settings_merger"),text:$model.merger)
                Text(verbatim:(model.collaborators?.logins ?? []).joined(separator:", "))
                if model.collaborators?.collaboratorsUnavailable == true { Text(L.t("native_settings_people_unavailable")) }
                Button(L.t("native_settings_roles_save")) { model.requestWorkspaceAction("roles") }
            }
            Button(L.t("native_settings_pull")) { model.requestWorkspaceAction("pull") }.disabled(model.repo.isEmpty)
            if model.collaborators?.isFork == true {
                Button(L.t("native_settings_sync")) { model.requestWorkspaceAction("sync") }
            }
            TextField(L.t("native_settings_fork_target"),text:$model.forkTarget)
            Button(L.t("native_settings_fork")) { model.requestWorkspaceAction("fork") }.disabled(model.forkTarget.isEmpty)
            Button(L.t("native_settings_browse_root")) { browse(model.snapshot?.settings.repoRoot) }
            if let listing = model.directories {
                Text(verbatim:listing.display)
                if let parent = listing.parent { Button(L.t("native_settings_parent")) { browse(parent) } }
                ForEach(listing.entries,id:\.path) { row in Button(row.name) { browse(row.path) } }
                Button(L.t("native_settings_use_folder")) { model.requestWorkspaceAction("root") }
            }
        }.padding().disabled(model.busy)
        .confirmationDialog(L.t("native_settings_repo_confirm"),isPresented:Binding(
            get:{model.workspaceAction != nil},set:{if !$0 {model.cancelWorkspaceAction()}})) {
            Button(L.t("common_save")) { model.applyWorkspaceAction(client: client) }
        } message: {
            Text(verbatim:model.workspaceTarget)
            if model.workspaceAction == "roles" { Text(L.t("native_settings_roles_push_notice")) }
            if model.workspaceAction == "config" { Text(L.t("native_settings_automation_notice")) }
        }
    }
    private func browse(_ path: String?) {
        model.run({ try await client.listDirectories(path:path) },commit:{ model.directories = $0 })
    }
}
