import Testing
@testable import Shepherd

struct SettingsStringsTests {
    @Test func labelsAndUnknownDiagnosticsResolve() {
        #expect(L.t("native_settings_command_palette") != "native_settings_command_palette")
        #expect(SettingsDiagnosticCopy.text("not_a_known_key", params: [:])
            == L.t("native_settings_diagnostic_unknown"))
        #expect(SettingsDiagnosticCopy.text("diagnostics_hint_bun_missing", params: [:])
            != "diagnostics_hint_bun_missing")
    }
}
