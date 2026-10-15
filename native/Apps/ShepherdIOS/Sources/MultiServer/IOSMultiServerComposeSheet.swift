import SwiftUI
import Observation
import ShepherdAppCore
import ShepherdKit

/// One repo across servers: the same remote (or, without one, the same name) is one entry.
struct IOSComposeRepoChoice: Identifiable, Equatable {
    let key: String
    let name: String
    let paths: [UUID: String]
    var id: String { key }

    static func key(_ repo: Repo) -> String {
        if let slug = repo.remoteSlug?.lowercased(), !slug.isEmpty { return "remote:\(slug)" }
        return "name:\(repo.name.lowercased())"
    }
    @MainActor static func choices(_ hub: IOSServerHub) -> [IOSComposeRepoChoice] {
        var order: [String] = [], names: [String: String] = [:], paths: [String: [UUID: String]] = [:]
        for id in hub.connectedIDs where IOSComposeTarget.selectable(hub.models[id]) {
            for repo in hub.models[id]?.store?.repos ?? [] where !repo.hidden {
                let key = key(repo)
                if names[key] == nil { order.append(key); names[key] = repo.name }
                if paths[key]?[id] == nil { paths[key, default: [:]][id] = repo.path }
            }
        }
        return order.map { IOSComposeRepoChoice(key: $0, name: names[$0] ?? "", paths: paths[$0] ?? [:]) }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }
}

/// What the multi-server composer hands its content: the merged repo list and how a pick routes.
struct IOSComposeRepoCatalogue {
    let choices: [IOSComposeRepoChoice]
    let selectedKey: String?
    let serverNames: (IOSComposeRepoChoice) -> String
    let pick: (IOSComposeRepoChoice) -> Void
    let repoChanged: (String) -> Void
}

@Observable
@MainActor
final class IOSComposeTarget {
    private(set) var profileID: UUID?
    private(set) var repoKey: String?
    var prompt = ""
    /// The pick and the chips a Run on choice takes to another server (#2776).
    var runOn: IOSRunOnCarry?
    init(hub: IOSServerHub) {
        profileID = hub.connectedIDs.first { hub.models[$0] === hub.composeModel }
    }
    static func selectable(_ app: AppModel?) -> Bool { app?.store != nil && app?.liveRequestAudit == nil }
    func select(_ id: UUID, hub: IOSServerHub) {
        guard Self.selectable(hub.models[id]) else { return }
        profileID = id
    }
    func model(in hub: IOSServerHub) -> AppModel? { profileID.flatMap { hub.models[$0] } }

    /// The content reports the path it settled on; remember which repo that is, not the path.
    func repoChanged(_ path: String, hub: IOSServerHub) {
        guard let repo = model(in: hub)?.store?.repos.first(where: { $0.path == path }) else { return }
        repoKey = IOSComposeRepoChoice.key(repo)
    }
    /// A repo the current server lacks moves the composer to the first server that has it.
    func pick(_ choice: IOSComposeRepoChoice, hub: IOSServerHub) {
        repoKey = choice.key
        if let profileID, choice.paths[profileID] != nil { return }
        let candidates = hub.connectedIDs.filter { choice.paths[$0] != nil && Self.selectable(hub.models[$0]) }
        if let id = candidates.first(where: { hub.models[$0].map(hub.isLive) == true })
            ?? candidates.first(where: { hub.models[$0].map { !hub.isUnavailable($0) } == true })
            ?? candidates.first { profileID = id }
    }
    func repoPath(in hub: IOSServerHub) -> String {
        guard let repoKey, let store = model(in: hub)?.store else { return "" }
        return store.repos.first { !$0.hidden && IOSComposeRepoChoice.key($0) == repoKey }?.path ?? ""
    }
    /// Offline targets stay selectable; a chosen repo restricts this to servers carrying it.
    func servers(in hub: IOSServerHub) -> [UUID] {
        hub.connectedIDs.filter { id in
            guard Self.selectable(hub.models[id]) else { return false }
            guard let repoKey else { return true }
            return hub.models[id]?.store?.repos.contains { !$0.hidden && IOSComposeRepoChoice.key($0) == repoKey } == true
        }
    }
}

struct IOSMultiServerComposeSheet: View {
    let owner: AppModel
    @Environment(IOSServerHub.self) private var hub
    @State private var target: IOSComposeTarget?
    var body: some View {
        // The background keeps the sheet non-empty: an empty body never fires onAppear,
        // so the target was never created and the sheet stayed blank.
        ZStack {
            ComposePalette.bg.ignoresSafeArea()
            if hub.connected.count == 1 { IOSComposeSheet().environment(owner) }
            else if let target, let app = target.model(in: hub), let store = app.store {
                let activation = app.activationGeneration
                // The task is submitted through this server, which chooses the machine (#2776);
                // the other servers are Run on choices, no longer a separate picker.
                IOSComposeContent(app: app, store: store, activation: activation,
                    fixtureCurrent: { owner.sheet == .newSession && app.store === store && app.activationGeneration == activation && target.model(in: hub) === app },
                    servers: runOnServers(target),
                    repoCatalogue: catalogue(target),
                    close: { owner.sheet = nil },
                    onCreated: { id in
                        if let profileID = target.profileID { hub.select(.init(profileID: profileID, sessionID: id)) }
                        owner.sheet = nil
                    }, initialPrompt: target.prompt, initialRepoPath: target.repoPath(in: hub), initialRunOn: target.runOn,
                    promptChanged: { target.prompt = $0 })
                    .id(ObjectIdentifier(store))
            } else if let target {
                VStack(spacing: 16) {
                    IOSComposeServerPicker(hub: hub, target: target)
                    Text(verbatim: L.t("native_ios_connecting"))
                    Button(L.t("common_cancel")) { owner.sheet = nil }
                }.padding().foregroundStyle(ComposePalette.ink)
            }
        }.onAppear { if target == nil { target = IOSComposeTarget(hub: hub) } }
    }
    /// The entry server and the other connected servers carrying the repo, as Run on choices.
    private func runOnServers(_ target: IOSComposeTarget) -> IOSRunOnServers? {
        func server(_ id: UUID) -> IOSRunOnServer? {
            guard let profile = hub.profiles.first(where: { $0.id == id }) else { return nil }
            return IOSRunOnServer(profileID: id, name: profile.name,
                                  instanceID: hub.models[id]?.extension(IOSInstanceIdentity.self)?.instanceID)
        }
        guard let entryID = target.profileID, let entry = server(entryID) else { return nil }
        let others = target.servers(in: hub).filter { $0 != entryID }.compactMap(server)
        return IOSRunOnServers(entry: entry, others: others, switchTo: { next, carry in
            target.runOn = carry
            target.select(next.profileID, hub: hub)
        })
    }
    private func catalogue(_ target: IOSComposeTarget) -> IOSComposeRepoCatalogue {
        IOSComposeRepoCatalogue(choices: IOSComposeRepoChoice.choices(hub), selectedKey: target.repoKey,
            serverNames: { choice in hub.connectedIDs.filter { choice.paths[$0] != nil }
                .compactMap { id in hub.profiles.first { $0.id == id }?.name }.joined(separator: " · ") },
            pick: { target.pick($0, hub: hub) },
            repoChanged: { target.repoChanged($0, hub: hub) })
    }
}

struct IOSComposeServerPicker: View {
    let hub: IOSServerHub
    let target: IOSComposeTarget
    @Environment(\.composeRendering) private var rendering
    /// Only servers that carry the chosen repo; with a single one there is nothing to choose.
    private var servers: [UUID] { target.servers(in: hub) }
    var body: some View {
        let label = HStack {
            Text(verbatim: L.t("native_toolbar_servers"))
            Spacer()
            Text(verbatim: target.profileID.flatMap { id in hub.profiles.first { $0.id == id }?.name } ?? "—")
                .lineLimit(1).truncationMode(.tail)
            if servers.count > 1 { Image(systemName: "chevron.down") }
        }.font(.system(.caption, design: .monospaced)).foregroundStyle(ComposePalette.ink)
            .frame(minHeight: 44).padding(.horizontal, 10)
            .overlay { RoundedRectangle(cornerRadius: 6).stroke(ComposePalette.line) }
        Group {
            if rendering || servers.count < 2 { label }
            else {
                Menu {
                    ForEach(servers, id: \.self) { id in
                        if let profile = hub.profiles.first(where: { $0.id == id }) {
                            Button { target.select(id, hub: hub) } label: {
                                if id == target.profileID { Label(profile.name, systemImage: "checkmark") }
                                else { Text(verbatim: profile.name) }
                            }
                        }
                    }
                } label: { label }
            }
        }.accessibilityLabel(L.t("native_toolbar_servers"))
            .accessibilityIdentifier("compose.server")
    }
}
