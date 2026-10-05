import SwiftUI
import Observation
import ShepherdAppCore
import ShepherdKit

@Observable
@MainActor
final class IOSComposeTarget {
    private(set) var profileID: UUID?
    var prompt = ""
    init(hub: IOSServerHub) {
        profileID = hub.connectedIDs.first { hub.models[$0] === hub.composeModel }
    }
    func select(_ id: UUID, hub: IOSServerHub) {
        guard let app = hub.models[id], app.store != nil, app.liveRequestAudit == nil else { return }
        profileID = id
    }
    func model(in hub: IOSServerHub) -> AppModel? { profileID.flatMap { hub.models[$0] } }
}

struct IOSMultiServerComposeSheet: View {
    let owner: AppModel
    @Environment(IOSServerHub.self) private var hub
    @State private var target: IOSComposeTarget?
    var body: some View {
        Group {
            if hub.connected.count == 1 { IOSComposeSheet().environment(owner) }
            else if let target, let app = target.model(in: hub), let store = app.store {
                let activation = app.activationGeneration
                IOSComposeContent(app: app, store: store, activation: activation,
                    fixtureCurrent: { owner.sheet == .newSession && app.store === store && app.activationGeneration == activation && target.model(in: hub) === app },
                    serverPicker: AnyView(IOSComposeServerPicker(hub: hub, target: target)),
                    close: { owner.sheet = nil },
                    onCreated: { id in
                        if let profileID = target.profileID { hub.select(.init(profileID: profileID, sessionID: id)) }
                        owner.sheet = nil
                    }, initialPrompt: target.prompt, promptChanged: { target.prompt = $0 })
                    .id(ObjectIdentifier(store))
            } else if let target {
                VStack(spacing: 16) {
                    IOSComposeServerPicker(hub: hub, target: target)
                    Text(verbatim: L.t("native_ios_connecting"))
                    Button(L.t("common_cancel")) { owner.sheet = nil }
                }.padding().background(ComposePalette.bg).foregroundStyle(ComposePalette.ink)
            }
        }.onAppear { if target == nil { target = IOSComposeTarget(hub: hub) } }
    }
}

struct IOSComposeServerPicker: View {
    let hub: IOSServerHub
    let target: IOSComposeTarget
    @Environment(\.composeRendering) private var rendering
    var body: some View {
        let label = HStack {
            Text(verbatim: L.t("native_toolbar_servers"))
            Spacer()
            Text(verbatim: target.profileID.flatMap { id in hub.profiles.first { $0.id == id }?.name } ?? "—")
                .lineLimit(1).truncationMode(.tail)
            Image(systemName: "chevron.down")
        }.font(.system(.caption, design: .monospaced)).foregroundStyle(ComposePalette.ink)
            .frame(minHeight: 44).padding(.horizontal, 10)
            .overlay { RoundedRectangle(cornerRadius: 6).stroke(ComposePalette.line) }
        Group {
            if rendering { label }
            else {
                Menu {
                    ForEach(hub.connectedIDs, id: \.self) { id in
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
