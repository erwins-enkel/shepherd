import SwiftUI
import ShepherdKit

public enum SettingsTokenCopy {
    public static func scope(_ scope: Components.Schemas.TokenScope) -> String {
        switch scope {
        case .read: L.t("native_settings_scope_read")
        case .submit: L.t("native_settings_scope_submit")
        case .full: L.t("native_settings_scope_full")
        }
    }
    public static func scopeHint(_ scope: Components.Schemas.TokenScope) -> String {
        switch scope {
        case .read: L.t("settings_access_scope_read_hint")
        case .submit: L.t("settings_access_scope_submit_hint")
        case .full: L.t("settings_access_scope_full_hint")
        }
    }
    public static func date(_ milliseconds: Int) -> String {
        Date(timeIntervalSince1970: Double(milliseconds) / 1_000)
            .formatted(date: .abbreviated, time: .shortened)
    }
    public static func expired(_ expiry: Int?, now: Date = .now) -> Bool {
        expiry.map { Double($0) <= now.timeIntervalSince1970 * 1_000 } ?? false
    }
}
