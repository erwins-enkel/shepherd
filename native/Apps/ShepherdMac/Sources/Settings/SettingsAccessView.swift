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
                Text(verbatim: SettingsTokenCopy.scopeHint(scope)).font(.caption).foregroundStyle(.secondary)
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
                            Text(verbatim: "\(token.hint) · \(SettingsTokenCopy.scope(token.scope))")
                            Text(L.t("settings_access_created", SettingsTokenCopy.date(token.createdAt)))
                            if let used = token.lastUsedAt {
                                Text(L.t("settings_access_last_used", SettingsTokenCopy.date(used)))
                            } else { Text(L.t("settings_access_never_used")) }
                            if let expiry = token.expiresAt {
                                Text(L.t("settings_access_expires", SettingsTokenCopy.date(expiry)))
                                if SettingsTokenCopy.expired(token.expiresAt) {
                                    Label(L.t("settings_access_expired"), systemImage: "clock.badge.exclamationmark")
                                        .foregroundStyle(.secondary)
                                }
                            } else { Text(L.t("settings_access_expires_never")) }
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


enum SettingsTokenCopy {
    static func scope(_ scope: Components.Schemas.TokenScope) -> String {
        switch scope {
        case .read: L.t("native_settings_scope_read")
        case .submit: L.t("native_settings_scope_submit")
        case .full: L.t("native_settings_scope_full")
        }
    }
    static func scopeHint(_ scope: Components.Schemas.TokenScope) -> String {
        switch scope {
        case .read: L.t("settings_access_scope_read_hint")
        case .submit: L.t("settings_access_scope_submit_hint")
        case .full: L.t("settings_access_scope_full_hint")
        }
    }
    static func date(_ milliseconds: Int) -> String {
        Date(timeIntervalSince1970: Double(milliseconds) / 1_000)
            .formatted(date: .abbreviated, time: .shortened)
    }
    static func expired(_ expiry: Int?, now: Date = .now) -> Bool {
        expiry.map { Double($0) <= now.timeIntervalSince1970 * 1_000 } ?? false
    }
}
