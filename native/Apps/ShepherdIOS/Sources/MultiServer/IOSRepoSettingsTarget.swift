import SwiftUI
import ShepherdAppCore
import ShepherdKit

struct IOSRepoSettingsTarget: Identifiable, Hashable {
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id && lhs.client.profile.id == rhs.client.profile.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id); hasher.combine(client.profile.id) }
    let client: ShepherdClient
    let path: String
    let name: String
    let slug: String?
    var id: String { slug ?? "\(client.profile.id):\(path)" }

    /// Filtering still groups by name. Settings instead split that group by remote identity,
    /// and choose one coordinator connection for the complete lifetime of the destination.
    @MainActor static func targets(chip: IOSMergedSessionPresentation.Chip, hub: IOSServerHub) -> [Self] {
        var targets: [Self] = []
        let sources = [hub.focused] + hub.connected.filter { $0 !== hub.focused }
        for app in sources {
            guard let store = app.store else { continue }
            for repo in store.repos where chip.paths.contains(repo.path) {
                let slug = repo.remoteSlug.flatMap { $0.isEmpty ? nil : $0.lowercased() }
                let target = Self(client: store.client, path: repo.path, name: repo.name, slug: slug)
                if !targets.contains(where: { $0.id == target.id }) { targets.append(target) }
            }
        }
        // A session can outlive a checkout's entry in /api/repos. Keep its filter row and
        // use its own remote identity instead of guessing from the displayed name.
        for app in sources {
            guard let store = app.store else { continue }
            for session in store.sessions + store.remoteSessions where chip.paths.contains(session.repoPath) {
                if targets.contains(where: { $0.client === store.client && $0.path == session.repoPath }) { continue }
                let slug = session.remoteSlug.flatMap { $0.isEmpty ? nil : $0.lowercased() }
                let target = Self(client: store.client, path: session.repoPath, name: chip.name, slug: slug)
                if !targets.contains(where: { $0.id == target.id }) { targets.append(target) }
            }
        }
        return targets
    }
}

struct IOSRepoSettingsStatus: View {
    let target: IOSRepoSettingsTarget
    @State private var status: String?
    var body: some View {
        VStack(alignment: .leading) {
            if let slug = target.slug { Text(verbatim: slug) }
            Text(verbatim: status ?? L.t("common_loading"))
        }.sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
            .accessibilityElement(children: .combine)
            .task(id: target.id) {
                guard let slug = target.slug else { status = L.t("native_repo_local_only"); return }
                do { status = IOSRepoSettingsModel.status(try await target.client.getRepoConfigProject(remoteSlug: slug)) }
                catch { status = L.t("native_repo_status_unavailable") }
            }
    }
}

struct IOSLocalRepoSettingsView: View {
    let client: ShepherdClient
    let repo: String
    let name: String
    @State private var config: RepoConfig?
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        Form {
            Section(L.t("native_repo_local_only")) {
                if let config {
                    IOSRepoMachineFields(config: config) { patch in
                        Task {
                            busy = true; defer { busy = false }
                            do {
                                let body = try JSONDecoder().decode(RepoConfigPatch.self, from: JSONEncoder().encode(patch))
                                self.config = try await client.putRepoConfig(repo: repo, body: body)
                                error = nil
                            } catch { self.error = error.localizedDescription }
                        }
                    }.disabled(busy)
                } else if busy { ProgressView() }
            }
            if let error { Text(verbatim: error).foregroundStyle(SessionListStyle.red) }
        }.sessionFont().tint(SessionListStyle.amber)
            .scrollContentBackground(.hidden).background(SessionListStyle.background).navigationTitle(name)
            .task {
                busy = true; defer { busy = false }
                do { config = try await client.getRepoConfig(repo: repo) }
                catch { self.error = error.localizedDescription }
            }
    }
}
