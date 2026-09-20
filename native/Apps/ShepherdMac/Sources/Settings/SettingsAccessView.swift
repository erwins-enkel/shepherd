import SwiftUI
import ShepherdKit

struct SettingsAccessView: View {
    let app: AppModel
    let settings: SettingsModel
    @State private var password = ""
    @State private var name = ""
    @State private var days = 0
    @State private var scope: Components.Schemas.TokenScope = .read
    @State private var revokeID: String?
    var body: some View {
        let model = settings.tokens
        Form {
            if settings.snapshot?.settings.envTokenActive == true { Text(L.t("native_settings_env_token")) }
            if let error = model.error { Text(verbatim: error).foregroundStyle(.red) }
            if !model.authenticated {
                SecureField(L.t("login_password_label"), text: $password)
                Button(L.t("native_settings_token_login")) {
                    guard let profile = app.activeProfile else { return }
                    let secret = password; password = ""
                    model.authenticate(profile: profile, password: secret, activeClient: app.store?.client)
                }.disabled(password.isEmpty || model.busy)
            } else {
                TextField(L.t("native_settings_token_name"), text: $name)
                Picker(L.t("native_settings_token_expiry"), selection: $days) {
                    Text(L.t("native_settings_never")).tag(0)
                    ForEach([30,90,365], id: \.self) { Text(L.t("native_settings_days", String($0))).tag($0) }
                }
                Picker(L.t("native_settings_token_scope"), selection: $scope) {
                    Text(L.t("native_settings_scope_read")).tag(Components.Schemas.TokenScope.read)
                    Text(L.t("native_settings_scope_submit")).tag(Components.Schemas.TokenScope.submit)
                    Text(L.t("native_settings_scope_full")).tag(Components.Schemas.TokenScope.full)
                }
                Button(L.t("native_settings_token_create")) {
                    model.mint(name: name, days: days == 0 ? nil : .init(rawValue:days), scope: scope)
                    name = ""
                }.disabled(SettingsTokensModel.normalizedName(name) == nil || model.busy)
                if let revealed = model.revealed {
                    Text(L.t("native_settings_token_once"))
                    Text(verbatim: revealed).textSelection(.enabled).privacySensitive()
                }
                ForEach(model.entries, id: \.id) { token in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(verbatim: token.name)
                            Text(verbatim: "\(token.hint) · \(token.scope.rawValue)")
                            if let expiry = token.expiresAt { Text(Date(timeIntervalSince1970: Double(expiry)/1000), style: .date) }
                        }
                        Button(L.t("native_settings_revoke"), role: .destructive) { revokeID = token.id }
                            .disabled(!model.canRevoke(id: token.id))
                        if !model.canRevoke(id: token.id) {
                            Text(L.t("native_settings_active_token_protected"))
                        }
                    }
                }
                Button(L.t("native_settings_lock_access")) { model.close() }
            }
        }.padding().disabled(model.busy)
        .confirmationDialog(L.t("native_settings_revoke_confirm"), isPresented: Binding(
            get: { revokeID != nil }, set: { if !$0 { revokeID = nil } })) {
            Button(L.t("native_settings_revoke"), role: .destructive) {
                guard let id = revokeID else { return }; revokeID = nil; model.revoke(id: id)
            }
        }
        .onDisappear { password = ""; model.close() }
        .onChange(of: app.activationGeneration) { password = ""; model.close() }
    }
}
