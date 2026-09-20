import SwiftUI
import ShepherdKit

struct SettingsWorkspaceView: View {
    let model: SettingsModel
    let client: ShepherdClient
    @State private var reviewer = ""
    @State private var merger = ""
    @State private var forkTarget = ""
    @State private var confirmation: String?
    @State private var pendingConfig: RepoConfigPatch?
    var body: some View {
        Form {
            if let error = model.error { Text(verbatim:error).foregroundStyle(.red) }
            Picker(L.t("native_settings_repo"), selection:Binding(get:{model.repo},set:{model.selectRepo($0,client:client)})) {
                Text(L.t("native_settings_select_repo")).tag("")
                ForEach(model.snapshot?.repos ?? [],id:\.path) { Text(verbatim:$0.display).tag($0.path) }
            }
            if let config = model.repoConfig {
                SettingsRepoFields(config:config) { pendingConfig = $0; confirmation = "config" }
            }
            if let roles = model.roles {
                TextField(L.t("native_settings_reviewer"),text:$reviewer)
                TextField(L.t("native_settings_merger"),text:$merger)
                Text(verbatim:(model.collaborators?.logins ?? []).joined(separator:", "))
                if model.collaborators?.collaboratorsUnavailable == true { Text(L.t("native_settings_people_unavailable")) }
                Button(L.t("native_settings_roles_save")) { confirmation = "roles" }
                .onAppear { reviewer = roles.roles.reviewer ?? ""; merger = roles.roles.merger ?? "" }
                .onChange(of:model.repo) { reviewer = model.roles?.roles.reviewer ?? ""; merger = model.roles?.roles.merger ?? "" }
            }
            Button(L.t("native_settings_pull")) { confirmation = "pull" }.disabled(model.repo.isEmpty)
            if model.collaborators?.isFork == true {
                Button(L.t("native_settings_sync")) { confirmation = "sync" }
            }
            TextField(L.t("native_settings_fork_target"),text:$forkTarget)
            Button(L.t("native_settings_fork")) { confirmation = "fork" }.disabled(forkTarget.isEmpty)
            Button(L.t("native_settings_browse_root")) { browse(model.snapshot?.settings.repoRoot) }
            if let listing = model.directories {
                Text(verbatim:listing.display)
                if let parent = listing.parent { Button(L.t("native_settings_parent")) { browse(parent) } }
                ForEach(listing.entries,id:\.path) { row in Button(row.name) { browse(row.path) } }
                Button(L.t("native_settings_use_folder")) { confirmation = "root" }
            }
        }.padding().disabled(model.busy)
        .confirmationDialog(L.t("native_settings_repo_confirm"),isPresented:Binding(
            get:{confirmation != nil},set:{if !$0 {confirmation = nil}})) {
            Button(L.t("common_save")) { apply() }
        } message: {
            Text(verbatim:confirmation == "fork" ? forkTarget : model.repo)
            if confirmation == "roles" { Text(L.t("native_settings_roles_push_notice")) }
            if confirmation == "config" { Text(L.t("native_settings_automation_notice")) }
        }
    }
    private func browse(_ path: String?) {
        model.run({ try await client.listDirectories(path:path) },commit:{ model.directories = $0 })
    }
    private func apply() {
        let action = confirmation; confirmation = nil
        let repo = model.repo
        switch action {
        case "config":
            guard var patch = pendingConfig else {return}; pendingConfig = nil
            patch.automationConfirmed = true
            let confirmed = patch
            model.run({try await client.putRepoConfig(repo:repo,body:confirmed)},commit:{model.repoConfig = $0})
        case "roles":
            let reviewer = reviewer.isEmpty ? nil : reviewer
            let merger = merger.isEmpty ? nil : merger
            model.run({try await client.putRepoRoles(repo:repo,body:.values(reviewer:reviewer,merger:merger))},commit:{model.roles = $0})
        case "pull": model.run {try await client.pullRepo(body:.init(repo:repo))}
        case "sync": model.run {try await client.syncFork(body:.init(repo:repo))}
        case "fork": let target = forkTarget; model.run {try await client.forkRepo(body:.init(target:target))}
        case "root":
            guard let path = model.directories?.path else {return}
            model.run {try await client.putRepoRoot(path)}
        default: break
        }
    }
}
