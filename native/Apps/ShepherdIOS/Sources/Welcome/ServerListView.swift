import SwiftUI
import ShepherdAppCore
import ShepherdKit

struct ServerListView: View {
    @Environment(AppModel.self) private var app
    @Environment(IOSServerHub.self) private var hub: IOSServerHub?
    @State private var pairing = false
    @State private var adding = false
    @State private var addingName = ""
    @State private var removing: ServerProfile?
    @State private var pendingLogin: ServerProfile?
    var body: some View {
        List {
            Section {
                Text(verbatim: L.t("native_ios_welcome_subtitle"))
                    .foregroundStyle(.secondary)
                Button(L.t("native_toolbar_add_server")) { addingName = ""; adding = true }
                    .accessibilityIdentifier("add-server")
                if (hub?.profiles ?? app.savedServers).isEmpty {
                    Button { pairing = true } label: {
                        Label(L.t("native_pairing_connect"), systemImage: "qrcode.viewfinder")
                    }.accessibilityLabel(L.t("native_pairing_scan"))
                        .accessibilityIdentifier("scan-pairing-qr")
                }
            }
            Section(L.t("native_welcome_saved_title")) {
                let mirrored = hub.map { IOSMergedSessionPresentation.mirroredMachines(IOSMergedSessionPresentation.sources($0)) } ?? [:]
                ForEach(hub?.profiles ?? app.savedServers) { profile in
                    Button { Task {
                        if let hub { await hub.connect(profile) } else { await app.activate(profile) }
                    } } label: {
                        VStack(alignment: .leading) {
                            HStack {
                                Text(verbatim: profile.name)
                                if let hub {
                                    Spacer()
                                    Text(verbatim: L.t(hub.models[profile.id] == nil ? "native_ios_server_disconnected" : "native_ios_server_connected"))
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            Text(verbatim: profile.baseURL.absoluteString).font(.caption).foregroundStyle(.secondary)
                        }.padding(.vertical, 6)
                    }
                    .accessibilityIdentifier("server-\(profile.id)")
                    .swipeActions {
                        if let hub, hub.models[profile.id] != nil {
                            Button(L.t("native_ios_server_disconnect")) { hub.disconnect(profile.id) }.tint(.orange)
                        }
                        Button(L.t("native_welcome_saved_remove"), role: .destructive) { removing = profile }
                    }
                    ForEach(mirrored[profile.id] ?? []) { machine in mirroredRow(machine, via: profile) }
                }
            }
            if let hub { IOSPushRelaySection(hub: hub) }
            if let warning = app.signOutWarning { Text(verbatim: warning).foregroundStyle(.orange) }
        }
        .navigationTitle(L.t("native_welcome_title"))
        .toolbar {
            if let hub, !hub.connected.isEmpty {
                ToolbarItem(placement: .confirmationAction) {
                    Button(L.t("common_close")) { hub.managingServers = false }
                }
            }
        }
        .accessibilityIdentifier("server-list")
        .sheet(isPresented: $adding, onDismiss: {
            if let profile = pendingLogin {
                pendingLogin = nil
                if let hub { hub.reloadCatalogue(); Task { await hub.connect(profile, login: true) } }
                else { app.sheet = .login(profile) }
            }
        }) { RemoteServerFormView(name: addingName) { pendingLogin = $0 }.environment(app) }
        .fullScreenCover(isPresented: $pairing) { PairingSheet().environment(app) }
        .confirmationDialog(L.t("native_welcome_saved_remove_confirm_title", removing?.name ?? ""),
            isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })) {
            if let profile = removing {
                Button(L.t("native_welcome_saved_remove_confirm_action"), role: .destructive) {
                    removing = nil
                    Task { if let hub { await hub.remove(profile) } else { await app.remove(profile) } }
                }
            }
        } message: { Text(verbatim: L.t("native_ios_remove_body")) }
    }

    /// A machine `via` mirrors: its sessions come through its own connection (and the copy is
    /// hidden), or only through `via`, and then it can be added as a server of its own.
    private func mirroredRow(_ machine: IOSMergedSessionPresentation.MirroredMachine, via: ServerProfile) -> some View {
        let offline = RemoteSessionCopy.isDisconnected(machine.connection)
        let relation = L.t(machine.direct ? "native_ios_server_mirror_direct" : "native_ios_server_mirror_only")
        return HStack(spacing: 8) {
            Circle().fill(SessionListStyle.machineTint(machine.host.instanceId)).frame(width: 6, height: 6)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: machine.host.name)
                Text(verbatim: "\(RemoteSessionCopy.stateLabel(machine.connection)) · \(relation)")
                    .font(.caption).foregroundStyle(offline ? Color.orange : .secondary)
            }
            .accessibilityElement(children: .combine)
            Spacer(minLength: 0)
            if !machine.direct {
                Button(L.t("native_ios_server_mirror_add")) { addingName = machine.host.name; adding = true }
                    .buttonStyle(.bordered).font(.caption)
                    .accessibilityLabel(L.t("native_ios_server_mirror_add_aria", machine.host.name))
                    .accessibilityIdentifier("mirror-add-\(machine.host.instanceId)")
            }
        }
        .padding(.leading, 16)
        .accessibilityIdentifier("mirrored-\(via.id)-\(machine.host.instanceId)")
    }
}
