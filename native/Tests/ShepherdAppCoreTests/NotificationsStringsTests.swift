import Testing

@testable import ShepherdAppCore

extension CoreSeamTests {
/// A missing catalog entry makes `String(localized:)` echo the key back, which would post a
/// banner reading `native_notify_done_title`.
@MainActor
struct NotificationsStringsTests {
    @Test func everyPlainKeyResolves() {
        let keys: [StaticString] = [
            "hold_blocked_awaiting_input", "hold_blocked_generic", "hold_blocked_menu",
            "hold_blocked_stall", "hold_blocked_yes_no", "hold_quota_error", "hold_quota_plan",
            "hold_quota_review", "hold_quota_rework", "native_notify_done_body",
            "native_notify_manual_steps_body", "native_notify_merge_error_title",
            "native_notify_ready_body", "native_notify_rebase_cap_title",
            "native_notify_settings_enabled", "native_notify_settings_menu_item",
            "native_notify_settings_permission_ask",
            "native_notify_settings_permission_denied", "native_notify_settings_quiet_hint",
            "native_notify_settings_title", "native_notify_usage_body",
            "settings_push_cat_agent", "settings_push_cat_ci",
        ]
        for key in keys {
            let value = L.t(key)
            #expect(!value.isEmpty)
            #expect(!value.contains("_"), "key \(key) did not resolve")
        }
    }

    @Test func argumentCarryingKeysInterpolate() {
        let keys: [StaticString] = [
            "native_notify_blocked_title", "native_notify_done_title",
            "native_notify_manual_steps_title", "native_notify_merge_error_body",
            "native_notify_ready_title", "native_notify_rebase_cap_body",
            "native_notify_settings_scope", "native_notify_usage_body_reset",
            "native_notify_usage_title",
        ]
        for key in keys {
            #expect(L.t(key, "MARKER").contains("MARKER"), "key \(key) dropped its argument")
        }
    }
}
}
