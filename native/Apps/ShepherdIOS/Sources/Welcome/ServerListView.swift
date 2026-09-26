import SwiftUI
import ShepherdAppCore
import ShepherdKit

struct ServerListView: View {
    @Environment(AppModel.self) private var app
    @State private var adding = false
    @State private var removing: ServerProfile?
    @State private var pendingLogin: ServerProfile?
    var body: some View {
        List {
            Section {
                Text(verbatim: L.t("native_ios_welcome_subtitle"))
                    .foregroundStyle(.secondary)
                Button(L.t("native_toolbar_add_server")) { adding = true }
                    .accessibilityIdentifier("add-server")
            }
            Section(L.t("native_welcome_saved_title")) {
                ForEach(app.savedServers) { profile in
                    Button { Task { await app.activate(profile) } } label: {
                        VStack(alignment: .leading) {
                            Text(verbatim: profile.name)
                            Text(verbatim: profile.baseURL.absoluteString).font(.caption).foregroundStyle(.secondary)
                        }.padding(.vertical, 6)
                    }
                    .accessibilityIdentifier("server-\(profile.id)")
                    .swipeActions {
                        Button(L.t("native_welcome_saved_remove"), role: .destructive) { removing = profile }
                    }
                }
            }
            if let warning = app.signOutWarning { Text(verbatim: warning).foregroundStyle(.orange) }
        }
        .navigationTitle(L.t("native_welcome_title"))
        .accessibilityIdentifier("server-list")
        .sheet(isPresented: $adding, onDismiss: {
            if let profile = pendingLogin { app.sheet = .login(profile); pendingLogin = nil }
        }) { RemoteServerFormView { pendingLogin = $0 }.environment(app) }
        .confirmationDialog(L.t("native_welcome_saved_remove_confirm_title", removing?.name ?? ""),
            isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })) {
            if let profile = removing {
                Button(L.t("native_welcome_saved_remove_confirm_action"), role: .destructive) {
                    removing = nil
                    Task { await app.remove(profile) }
                }
            }
        } message: { Text(verbatim: L.t("native_ios_remove_body")) }
    }
}
