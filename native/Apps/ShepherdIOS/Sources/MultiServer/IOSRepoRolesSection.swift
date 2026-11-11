import SwiftUI
import ShepherdAppCore
import ShepherdKit

/// .shepherd/roles.json roles have their own existing commit/PR flow, separate from config.json rules.
struct IOSRepoRolesSection: View {
    let client: ShepherdClient
    let slug: String
    let instanceID: String
    @State private var original: RepoRolesResult?
    @State private var reviewer = ""
    @State private var merger = ""
    @State private var confirming = false
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        Section {
            TextField(L.t("native_repo_reviewer"), text: $reviewer)
            TextField(L.t("native_repo_merger"), text: $merger)
            if let pending = original?.pending, let address = pending.url, let url = URL(string: address) {
                Link(L.t("native_repo_pending_pr", String(pending.number)), destination: url)
            }
            if let original, reviewer != ((original.pending?.roles ?? original.roles).reviewer ?? "") || merger != ((original.pending?.roles ?? original.roles).merger ?? "") {
                Button(L.t("native_repo_roles_review")) { confirming = true }
            }
            if let error { Text(verbatim: error).foregroundStyle(SessionListStyle.red) }
        } header: { Text(L.t("native_repo_roles")) }
          footer: { Text(L.t("native_repo_roles_footer")) }
        .textInputAutocapitalization(.never).autocorrectionDisabled().disabled(busy || original == nil)
        .task {
            do { adopt(try await client.getRepoConfigRoles(remoteSlug: slug, instanceID: instanceID)) }
            catch { self.error = error.localizedDescription }
        }
        .sheet(isPresented: $confirming) {
            NavigationStack {
                Form {
                    Text(verbatim: L.t("native_repo_reviewer") + ": \(original?.roles.reviewer ?? "—") → \(reviewer)")
                    Text(verbatim: L.t("native_repo_merger") + ": \(original?.roles.merger ?? "—") → \(merger)")
                    Text(L.t("native_repo_roles_footer"))
                    Text(verbatim: "chore(shepherd): set repo roles")
                    if let error { Text(verbatim: error).foregroundStyle(SessionListStyle.red) }
                    Button(L.t("native_repo_roles_save")) {
                        Task {
                            busy = true; defer { busy = false }
                            do {
                                adopt(try await client.putRepoConfigRoles(remoteSlug: slug, instanceID: instanceID, body: .values(
                                    reviewer: reviewer.isEmpty ? nil : reviewer, merger: merger.isEmpty ? nil : merger)))
                                error = nil; confirming = false
                            } catch { self.error = error.localizedDescription }
                        }
                    }.disabled(busy)
                }.sessionFont().tint(SessionListStyle.amber)
                    .navigationTitle(L.t("native_repo_roles"))
                    .toolbar { ToolbarItem(placement: .cancellationAction) {
                        Button(L.t("common_close")) { confirming = false }.disabled(busy)
                    } }.interactiveDismissDisabled(busy)
            }.preferredColorScheme(.dark)
        }
    }
    private func adopt(_ result: RepoRolesResult) {
        original = result
        let roles = result.pending?.roles ?? result.roles
        reviewer = roles.reviewer ?? ""
        merger = roles.merger ?? ""
    }
}
