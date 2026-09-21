import ShepherdAppCore
import SwiftUI
import Observation
import ShepherdKit

struct SettingsFieldRow: View {
    let field: SettingsField
    let payload: Components.Schemas.Settings
    let model: SettingsModel
    let save: @Sendable (SettingsPatch) async throws -> Components.Schemas.Settings
    @State private var draft = SettingsFieldDraft()
    var body: some View {
        @Bindable var draft = draft
        HStack {
            if field.kind == .toggle {
                Toggle(L.t(field.title), isOn: Binding(get: { field.value(payload) == "true" }, set: {
                    draft.text = $0 ? "true" : "false"
                    draft.submit(field: field, model: model, save: save)
                }))
            } else {
                Group {
                    if field.choices.isEmpty {
                        TextField(L.t(field.title), text: $draft.text)
                    } else {
                        Picker(L.t(field.title), selection: $draft.text) {
                            // Preserve a future server value until the operator changes it.
                            let choices = field.choices.contains(draft.text) ? field.choices : field.choices + [draft.text]
                            ForEach(choices, id: \.self) { Text(verbatim: field.choiceLabel($0)).tag($0) }
                        }
                    }
                }
                .onAppear { draft.text = field.value(payload) }
                .onChange(of: field.value(payload)) { draft.text = field.value(payload) }
                Button(L.t("common_save")) { draft.submit(field: field, model: model, save: save) }
                    .disabled(!draft.canSave(field: field, payload: payload))
            }
        }.accessibilityIdentifier("settings-" + field.id)
    }
}
struct SettingsGeneralView: View {
    let model: SettingsModel
    let client: ShepherdClient
    var cli = false
    @State private var query = ""
    @State private var apiKey = ""
    @State private var confirmKey = false
    var body: some View {
        Form {
            TextField(L.t("native_settings_search"), text: $query)
            if let error = model.error { Text(verbatim:error).foregroundStyle(.red) }
            if let payload = model.snapshot?.settings {
                ForEach(SettingsFields.all.filter { $0.cli == cli && (query.isEmpty || L.t($0.title).localizedCaseInsensitiveContains(query)) }) { field in
                    SettingsFieldRow(field:field,payload:payload,model:model) { patch in
                        _ = try await client.patchSettings(body: patch)
                        return try await client.settings()
                    }
                }
                if cli {
                    Text(L.t("settings_auth_mode_hint")).font(.caption).foregroundStyle(.secondary)
                    Text(payload.hasApiKey == true ? L.t("native_settings_key_present") : L.t("native_settings_key_absent"))
                    SecureField(L.t("native_settings_api_key"),text:$apiKey)
                    Button(L.t("native_settings_key_save")) { confirmKey = true }
                } else {
                    Text(verbatim:payload.repoRootDisplay)
                    if let days = payload.sessionRetentionDays, let keep = payload.sessionRetentionKeep {
                        Text(L.t("native_settings_retention", String(days), String(keep)))
                    }
                    if let low = payload.prReviewCyclesMin, let high = payload.prReviewCyclesMax {
                        Text(L.t("native_settings_pr_bounds", String(low), String(high)))
                    }
                    if let low = payload.planReviewCyclesMin, let high = payload.planReviewCyclesMax {
                        Text(L.t("native_settings_plan_bounds", String(low), String(high)))
                    }
                }
            } else { ProgressView() }
        }.padding().disabled(model.busy)
        .confirmationDialog(L.t("native_settings_key_confirm"),isPresented:$confirmKey) {
            Button(L.t("common_save")) {
                let value = apiKey; apiKey = ""
                model.patch(.init(anthropicApiKey:value),client:client)
            }
        }.onDisappear { apiKey = "" }
    }
}
