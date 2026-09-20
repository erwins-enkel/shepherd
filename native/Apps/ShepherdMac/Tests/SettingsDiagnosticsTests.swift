import Foundation
import Testing
import ShepherdKit
@testable import Shepherd
struct SettingsDiagnosticsTests {
    @Test func presentationLocalizesKnownCodesAndKeepsUnknownIDs() {
        #expect(SettingsDiagnosticCopy.label("host_capacity") == L.t("diagnostics_label_host_capacity"))
        #expect(SettingsDiagnosticCopy.state("warning") == L.t("diagnostics_state_warning"))
        #expect(SettingsDiagnosticCopy.label("future_check") == "future_check")
        #expect(SettingsDiagnosticCopy.documentation("unknown_hint") == nil)
        #expect(SettingsTokenCopy.expired(nil, now: Date(timeIntervalSince1970: 2)) == false)
        #expect(SettingsTokenCopy.expired(2_000, now: Date(timeIntervalSince1970: 2)))
        #expect(SettingsTokenCopy.expired(2_001, now: Date(timeIntervalSince1970: 2)) == false)
    }

    @Test func unknownStateDoesNotBreakTheWholeSnapshot() throws {
        let data = Data(#"{"checks":[{"id":"future","state":"new_state","hintKey":"future_hint"}],"generatedAt":1,"overall":"new_state"}"#.utf8)
        let snapshot = try JSONDecoder().decode(DiagnosticsSnapshot.self,from:data)
        #expect(snapshot.overall.known == nil)
        #expect(snapshot.checks.first?.state.rawValue == "new_state")
    }
    @Test func observedAndModelWindowsRemainDistinct() throws {
        let data = Data(#"{"session5h":null,"week":null,"perModelWeek":[{"model":"opus","pct":40,"resetAt":null,"scrapedAt":1,"stale":false}],"credits":null,"stale":false,"calibratedAt":null,"subscriptionOnly":true,"observed":{"session5h":{"pct":70,"resetAt":100,"scrapedAt":1},"week":null}}"#.utf8)
        let usage = try JSONDecoder().decode(UsageLimits.self,from:data)
        #expect(usage.subscriptionOnly)
        #expect(usage.perModelWeek.first?.pct == 40)
        #expect(usage.observed?.session5h?.pct == 70)
        #expect(usage.observed?.week == nil)
    }
    @Test func diagnoseLabelsResolveBeforePaneShips() {
        #expect(L.t("native_settings_refresh_diagnostics") != "native_settings_refresh_diagnostics")
        #expect(L.t("native_settings_fix_confirm") != "native_settings_fix_confirm")
        #expect(L.t("native_settings_observed_session", "70") != "native_settings_observed_session")
        #expect(L.t("native_settings_diagnostic_unknown") != "native_settings_diagnostic_unknown")
        #expect(L.t("diagnostics_hint_bun_missing") != "diagnostics_hint_bun_missing")
    }

    @Test func diagnosticCopyUsesSafeFallbackAndSuppliedParameters() {
        #expect(SettingsDiagnosticCopy.text("future_hint", params: [:])
            == L.t("native_settings_diagnostic_unknown"))
        #expect(SettingsDiagnosticCopy.text("diagnostics_hint_bun_missing", params: [:])
            == L.t("diagnostics_hint_bun_missing"))
        let params = ["memoryHigh": "8G", "cpuQuota": "200%", "units": "fixture.service"]
        let text = SettingsDiagnosticCopy.text("diagnostics_fix_action_host_capacity", params: params)
        #expect(text == L.t("diagnostics_fix_action_host_capacity", "8G", "200%", "fixture.service"))
        #expect(text.contains("8G")); #expect(text.contains("200%")); #expect(text.contains("fixture.service"))
        #expect(SettingsDiagnosticCopy.text("diagnostics_fix_action_host_capacity", params: [:])
            == L.t("diagnostics_fix_action_host_capacity", "—", "—", "—"))
    }

}
