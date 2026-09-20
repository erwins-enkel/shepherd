import Foundation
import Testing

@testable import Shepherd

/// Queue copy reuses the web catalog; both compiled localizations must ship every entry.
@MainActor
struct QueuesStringsTests {
    private static let plainKeys: [StaticString] = [
        "broadcast_clear_all", "broadcast_failed", "broadcast_no_sessions",
        "broadcast_placeholder", "broadcast_select_all", "broadcast_sending",
        "broadcast_steer", "broadcast_targets", "broadcast_textarea_aria",
        "broadcast_title", "common_loading", "common_retry",
        "donerecap_bringback", "donerecap_bringback_confirm", "halt_failed",
        "herd_done_empty", "newtask_edit_held_failed", "newtask_edit_held_saving",
        "newtask_edit_held_submit", "newtask_edit_held_title", "owed_empty",
        "owed_title", "recap_changed_files", "recap_empty_legacy",
        "recap_failed", "recap_failure_auth_action", "recap_failure_auth_headline",
        "recap_failure_default_model", "recap_failure_detail", "recap_failure_details",
        "recap_failure_invalid_result_headline", "recap_failure_launch_headline", "recap_failure_model",
        "recap_failure_no_result_headline", "recap_failure_provider", "recap_failure_provider_action",
        "recap_failure_source_action", "recap_failure_source_headline", "recap_failure_timeout_headline",
        "recap_generating", "recap_open_items", "recap_predates_feature",
        "recap_unavailable", "recap_verdict_needs_attention", "recap_verdict_parked",
        "recap_verdict_ready", "restore_branch_gone", "restore_branch_in_use",
        "restore_cannot", "restore_failed", "restore_in_progress",
        "restore_not_archived", "retry_continue_steer", "retry_empty",
        "retry_failed", "retry_halted_badge", "retry_title",
        "toast_held_edit_saved", "toast_revive_all", "toast_revive_all_failed",
        "topbar_held_reason_usage", "topbar_held_reason_capacity", "topbar_held_reason_unknown",
        "topbar_held_discard_confirm", "topbar_held_discard", "topbar_held_discard_failed", "topbar_held_discarding",
        "topbar_held_edit", "topbar_held_empty", "topbar_held_spawn_cli_label",
        "topbar_held_spawn_failed", "topbar_held_spawn_now", "topbar_held_spawning",
        "topbar_held_title", "upnext_batch_aria", "upnext_clear_selection",
        "upnext_confirm_yes", "upnext_empty", "upnext_normal_section",
        "upnext_picker_confirm", "upnext_picker_title", "upnext_pill_epic",
        "upnext_pill_priority", "upnext_priority_section", "upnext_refresh",
        "upnext_show_less", "upnext_sort_aria", "upnext_sort_newest",
        "upnext_sort_oldest", "upnext_sort_recommended", "upnext_sort_title_asc",
        "upnext_sort_title_desc", "upnext_start", "upnext_title",
        "usage_prompt_tokens_unit",
    ]

    // Argument counts follow first appearance in the EN source, as gen-strings specifies.
    private static let formattedKeys: [(StaticString, Int)] = [
        ("broadcast_confirm_send", 1), ("broadcast_send_to", 1), ("done_recap_finished", 1),
        ("done_recap_panel_aria", 1), ("halt_all_aria", 1), ("halt_arm", 1),
        ("halt_arm_aria", 1), ("halt_confirm", 1), ("halt_done", 1),
        ("halt_menu_item", 1), ("owed_repo_filter_empty", 1), ("restore_done", 1),
        ("retry_arm", 1), ("retry_confirm", 1), ("toast_auto_revived", 2),
        ("toast_broadcast_delivered", 1), ("toast_broadcast_result", 3), ("toast_broadcast_skipped_terminals", 1),
        ("toast_retry_done", 3), ("toast_revive_all_result", 2), ("toast_sessions_stranded", 1),
        ("topbar_held_badge", 1), ("topbar_held_original_cli", 1), ("upnext_confirm", 1),
        ("upnext_held", 1), ("upnext_repo_filter_empty", 1), ("upnext_select_aria", 2),
        ("upnext_show_all", 1), ("upnext_sort_by", 1), ("upnext_start_failed", 1),
        ("upnext_start_selected", 1), ("upnext_started", 1), ("upnext_updated_ago", 1),
    ]

    @Test func queueCopyResolvesThroughL() {
        for key in Self.plainKeys {
            let value = L.t(key)
            #expect(!value.isEmpty && value != "\(key)", "Missing queue copy: \(key)")
        }
        for (key, count) in Self.formattedKeys {
            let value: String
            switch count {
            case 1: value = L.t(key, "ARG1")
            case 2: value = L.t(key, "ARG1", "ARG2")
            default: value = L.t(key, "ARG1", "ARG2", "ARG3")
            }
            for index in 1...count { #expect(value.contains("ARG\(index)"), "\(key)") }
            #expect(!value.contains("%@") && !value.contains("$@"), "\(key)")
        }
    }

    @Test(arguments: ["en", "de"])
    func bothCompiledCatalogsResolveAndInterpolate(language: String) throws {
        let path = try #require(Bundle.main.path(forResource: language, ofType: "lproj"))
        let bundle = try #require(Bundle(path: path))
        for key in Self.plainKeys {
            let value = bundle.localizedString(forKey: "\(key)", value: nil, table: nil)
            #expect(!value.isEmpty && value != "\(key)", "\(language): \(key)")
        }
        for (key, count) in Self.formattedKeys {
            let format = bundle.localizedString(forKey: "\(key)", value: nil, table: nil)
            let markers = (1...count).map { "QUEUE_ARG_\($0)" }
            let arguments: [any CVarArg] = markers.map { $0 }
            let value = String(format: format, locale: Locale(identifier: language), arguments: arguments)
            for marker in markers { #expect(value.contains(marker), "\(language): \(key)") }
            #expect(!value.contains("%@") && !value.contains("$@"), "\(language): \(key)")
        }
        // Distinct values catch argument reordering, not just missing interpolation.
        let retry = bundle.localizedString(forKey: "toast_retry_done", value: nil, table: nil)
        let formatted = String(format: retry, "2", "3", "7")
        let expected = language == "en"
            ? "Retry sent · 2 resumed · 3 steered / 7"
            : "Wiederholen gesendet · 2 fortgesetzt · 3 gesteuert / 7"
        #expect(formatted == expected)
    }
}
