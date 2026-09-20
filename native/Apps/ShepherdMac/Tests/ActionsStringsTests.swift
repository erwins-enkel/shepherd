import Testing

@testable import Shepherd

/// A missing catalog entry makes `String(localized:)` echo the key back, which would ship a bar
/// full of snake_case.
@MainActor
struct ActionsStringsTests {
    @Test func everyPlainKeyResolves() {
        let keys: [StaticString] = [
            "amend_failed", "amend_original_task", "amend_placeholder", "amend_recorded",
            "amend_recorded_and_steered", "amend_recorded_not_steered", "amend_sending",
            "amend_steer_label", "amend_steer_offline", "amend_submit",
            "cardmenu_amend", "cardmenu_relaunch", "cardmenu_rename", "cardmenu_resume",
            "cardmenu_stop", "cardmenu_stop_title", "gitrail_ready", "gitrail_ready_aria",
            "gitrail_ready_off_title", "gitrail_ready_on_title", "native_actions_bar_label",
            "native_actions_ready_off", "native_actions_ready_on", "native_actions_recap_requested",
            "native_actions_relaunch_confirm_action",
            "native_actions_relaunch_confirm_body", "native_actions_relaunch_confirm_title",
            "recap_open_items", "recap_regenerate", "recap_regenerate_failed",
            "recap_verdict_needs_attention", "recap_verdict_parked", "recap_verdict_ready",
            "relaunch_archive_failed", "relaunch_in_progress", "relaunch_issue_unresolved",
            "viewport_rename_aria", "viewport_rename_branch_kept", "viewport_rename_failed",
            "viewport_rename_name_taken", "viewport_rename_placeholder",
        ]
        for key in keys {
            let value = L.t(key)
            #expect(!value.isEmpty)
            #expect(!value.contains("_"), "key \(key) did not resolve")
        }
    }

    @Test func argumentCarryingKeysInterpolate() {
        let keys: [StaticString] = [
            "amend_title", "cardmenu_resume_failed", "cardmenu_stop_failed",
            "cardmenu_stop_toast", "native_actions_failed", "native_actions_open_items",
            "native_actions_resumed", "relaunch_done", "toast_renamed",
        ]
        for key in keys {
            #expect(L.t(key, "MARKER").contains("MARKER"), "key \(key) dropped its argument")
        }
    }

    @Test func openItemsFormatsTheCountWithoutLeavingAPlaceholder() {
        let text = L.t("native_actions_open_items", "2")
        #expect(["Open items: 2", "Offene Punkte: 2"].contains(text))
    }
}
