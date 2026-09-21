import SwiftUI
import ShepherdKit

struct SettingsDiagnoseView: View {
    let model: SettingsModel
    let client: ShepherdClient
    @State private var fix: DiagnosticCheck?
    @State private var verify = false
    var body: some View {
        ScrollView {
            VStack(alignment:.leading,spacing:12) {
                if let recovery = model.recovery,
                   recovery.serverReachable == false || recovery.diagnosis(for: nil) == .runnerUnavailable {
                    BackendRecoveryPanel(failure: recovery.diagnosis(for: nil))
                }
                if let error = model.error { Text(verbatim:error).foregroundStyle(.red) }
                Button(L.t("native_settings_refresh_diagnostics")) {
                    Task { await model.recovery?.refresh() }
                }
                ForEach(model.diagnostics?.checks ?? [],id:\.id) { check in
                    GroupBox {
                        VStack(alignment:.leading) {
                            Text(verbatim: SettingsDiagnosticCopy.label(check.id) + " · "
                                + SettingsDiagnosticCopy.state(check.state.rawValue))
                            Text(SettingsDiagnosticCopy.text(check.hintKey,params:check.hintParams?.additionalProperties ?? [:]))
                            if let url = SettingsDiagnosticCopy.documentation(check.hintKey) {
                                Link(L.t("diagnostics_doc_link"), destination: url)
                            }
                            if check.state.known != .ok && (check.remediation != nil || check.fixActionKey != nil) {
                                Button(L.t("native_settings_fix")) { fix = check }
                            }
                        }
                    }
                }
                Button(L.t("native_settings_verify_key")) { verify = true }
                if let result = model.verification {
                    Text(result.ok ? L.t("native_settings_verify_ok") : L.t("native_settings_verify_failed"))
                    if let reason = result.reason { Text(verbatim:reason) }
                }
                if let usage = model.snapshot?.usage { SettingsUsageView(usage:usage) }
            }.padding().disabled(model.busy)
        }
        .sheet(isPresented:Binding(get:{fix != nil},set:{if !$0 {fix = nil}})) {
            if let check = fix {
                VStack(alignment:.leading,spacing:12) {
                    Text(L.t("native_settings_fix_confirm"))
                    if let command = check.remediation { Text(verbatim:command).font(.system(.body,design:.monospaced)) }
                    if let key = check.fixActionKey {
                        Text(SettingsDiagnosticCopy.text(key,params:check.fixActionParams?.additionalProperties ?? [:]))
                    }
                    Button(L.t("common_cancel")) { fix = nil }.keyboardShortcut(.cancelAction)
                    Button(L.t("native_settings_fix")) {
                        let id = check.id; fix = nil
                        Task { await model.runDiagnostic { try await client.fixDiagnostics(body: .init(checkId: id)) } }
                    }
                }.padding()
            }
        }
        .confirmationDialog(L.t("native_settings_verify_confirm"),isPresented:$verify) {
            Button(L.t("native_settings_verify_key")) {
                model.run({try await client.verifySettingsKey()},commit:{model.verification = $0})
            }
        }
    }
}
struct SettingsUsageView: View {
    let usage: UsageLimits
    var body: some View {
        GroupBox(L.t("native_settings_usage")) {
            VStack(alignment:.leading) {
                Text(usage.subscriptionOnly ? L.t("native_settings_subscription_only") : L.t("native_settings_usage_all"))
                if usage.stale { Text(L.t("native_settings_stale")) }
                if let at = usage.calibratedAt { Text(Date(timeIntervalSince1970:Double(at)/1000),style:.date) }
                ForEach(usage.perModelWeek,id:\.model) { window in
                    Text(L.t("native_settings_model_usage",window.model,String(window.pct)))
                    if window.stale { Text(L.t("native_settings_stale")) }
                }
                if let observed = usage.observed {
                    if let window = observed.session5h {
                        Text(L.t("native_settings_observed_session",String(window.pct)))
                        Text(Date(timeIntervalSince1970:Double(window.resetAt)/1000),style:.relative)
                    }
                    if let window = observed.week {
                        Text(L.t("native_settings_observed_week",String(window.pct)))
                        Text(Date(timeIntervalSince1970:Double(window.resetAt)/1000),style:.relative)
                    }
                } else { Text(L.t("native_settings_observed_absent")) }
                if let credits = usage.credits {
                    Text(L.t("native_settings_credits",String(credits.spent),String(credits.cap),credits.currency))
                    if credits.stale { Text(L.t("native_settings_stale")) }
                }
            }
        }
    }
}
