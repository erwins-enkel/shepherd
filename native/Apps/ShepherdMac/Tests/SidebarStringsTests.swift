import Testing

@testable import Shepherd

/// A missing catalog entry makes `String(localized:)` echo the key back, which would ship a screen
/// full of snake_case.
@MainActor
struct SidebarStringsTests {
    @Test func everyPlainKeyResolves() {
        let keys: [StaticString] = [
            "herd_lenses_label", "herd_seg_all", "herd_seg_ready", "herd_seg_done",
            "herd_seg_next", "herd_seg_owed", "herd_all_title", "herd_ready_title",
            "herd_done_title", "herd_next_title", "herd_owed_title", "herd_ready_empty",
            "herd_stage_name_active", "repo_switcher_label",
            "research_badge_label", "terminal_badge_label", "session_autopilot_paused_label",
            "unitrow_quota_rework", "unitrow_quota_review", "unitrow_quota_error",
            "usage_limits_window_5h", "usage_limits_window_week", "usage_limits_no_data",
            "usage_subscription_only", "native_herd_counter_active", "native_herd_counter_idle",
            "native_herd_counter_blocked", "native_herd_counter_total",
        ]
        for key in keys {
            let value = L.t(key)
            #expect(!value.isEmpty)
            #expect(!value.contains("_"), "key \(key) did not resolve")
        }
    }

    @Test func argumentCarryingKeysInterpolate() {
        let keys: [StaticString] = [
            "herd_ready_group", "herd_merging_group", "herd_merged_group",
            "herd_awaiting_merge_group", "herd_ci_running_group", "herd_ci_failed_group",
            "herd_reviewer_running_group", "herd_rework_running_group",
            "herd_changes_requested_group", "herd_merge_blocked_group",
            "herd_draft_awaiting_signoff_group", "herd_waiting_reviewer_group_multi",
            "herd_waiting_merger_group_multi", "unitrow_manual_steps",
            "repo_filter_apply_aria", "repo_filter_active_aria", "herd_repo_filter_empty",
        ]
        for key in keys {
            #expect(L.t(key, "7").contains("7"), "key \(key) dropped its argument")
        }
    }
}
