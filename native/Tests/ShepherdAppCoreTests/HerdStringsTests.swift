import Testing

@testable import ShepherdAppCore

extension CoreSeamTests {
/// Catalog contract for Tasks 7–8: the stepper, seven row badges and inline git rail.
/// Includes shared sidebar/detail keys so every string rendered by these surfaces is checked.
@MainActor
struct HerdStringsTests {
    @Test func everyRenderedKeyResolves() {
        let keys: [StaticString] = [
            "activity_active",
            "activity_ci_failure",
            "activity_ci_pending",
            "activity_ci_status",
            "activity_ci_success",
            "activity_closed",
            "activity_merged",
            "activity_progress",
            "activity_review_approved",
            "activity_review_changes",
            "activity_review_reviewing",
            "activity_review_status",
            "activity_stage_implementing",
            "activity_stage_planning",
            "activity_stage_pr",
            "activity_stage_ready",
            "activity_stage_review",
            "activity_starting",
            "clibadge_label_claude",
            "clibadge_label_codex",
            "clibadge_title",
            "criticbadge_changes",
            "criticbadge_commented",
            "criticbadge_error",
            "criticbadge_final",
            "criticbadge_final_title",
            "criticbadge_open_pr",
            "criticbadge_reviewing",
            "criticbadge_reviewing_activity_title",
            "criticbadge_reviewing_title",
            "criticbadge_round",
            "criticbadge_round_title",
            "criticbadge_stalled",
            "criticbadge_stalled_title",
            "criticbadge_title",
            "gitrail_ci_failing",
            "gitrail_ci_none",
            "gitrail_ci_passing",
            "gitrail_ci_pending",
            "gitrail_ci_status",
            "gitrail_merge_blocked_behind",
            "gitrail_merge_blocked_checks",
            "gitrail_merge_blocked_conflict",
            "gitrail_merge_blocked_draft",
            "gitrail_merge_blocked_protected",
            "heartbeat_legend_active_desc",
            "heartbeat_legend_active_label",
            "heartbeat_legend_error_desc",
            "heartbeat_legend_error_label",
            "heartbeat_legend_idle_desc",
            "heartbeat_legend_idle_label",
            "heartbeat_pop_intro",
            "issuebadge_label",
            "issuebadge_open_label",
            "issuebadge_title",
            "prbadge_behind",
            "prbadge_behind_title",
            "prbadge_button_title",
            "prbadge_closed",
            "prbadge_conflict",
            "prbadge_conflict_title",
            "prbadge_draft",
            "prbadge_merged",
            "prbadge_open",
            "prbadge_review_approved",
            "prbadge_review_changes",
            "prbadge_review_comment",
            "session_autopilot_complete_label",
            "session_autopilot_complete_title",
            "session_autopilot_paused_label",
            "session_autopilot_paused_title",
            "session_autopilot_unavailable_label",
            "session_autopilot_unavailable_title",
            "status_merging",
            "status_merging_tip",
            "status_ready_tip",
            "status_ready_to_merge",
            "stepper_desc_implementing",
            "stepper_desc_planning",
            "stepper_desc_pr",
            "stepper_desc_ready",
            "stepper_desc_review",
            "stepper_legend_done",
            "stepper_legend_now",
            "stepper_legend_pending",
            "stepper_legend_skipped",
            "stepper_open_hint",
            "unitrow_changes_requested",
            "unitrow_changes_requested_title",
            "unitrow_merge_blocked",
            "unitrow_merge_blocked_title",
            "unitrow_unknown_reviewer",
        ]
        for key in keys {
            let value = L.t(key)
            #expect(!value.isEmpty, "key \(key) resolved to empty text")
            #expect(value != "\(key)", "key \(key) is missing from the catalog")
        }
    }

    @Test func singleArgumentKeysInterpolate() {
        let keys: [StaticString] = [
            "activity_active",
            "activity_ci_status",
            "activity_progress",
            "activity_review_status",
            "clibadge_title",
            "criticbadge_reviewing_activity_title",
            "criticbadge_stalled_title",
            "gitrail_ci_status",
            "issuebadge_label",
            "issuebadge_open_label",
            "issuebadge_title",
            "prbadge_button_title",
            "prbadge_open",
            "session_autopilot_complete_title",
            "session_autopilot_paused_title",
            "unitrow_changes_requested",
            "unitrow_changes_requested_title",
        ]
        for key in keys {
            let value = L.t(key, "MARKER")
            #expect(value.contains("MARKER"), "key \(key) dropped its argument")
            #expect(!value.contains("%@") && !value.contains("$@"))
            #expect(!value.contains("{"), "key \(key) kept a web placeholder")
        }
    }

    @Test func criticRoundKeysPreserveBothArguments() {
        let keys: [StaticString] = ["criticbadge_round", "criticbadge_round_title"]
        for key in keys {
            let value = L.t(key, "ROUND", "CAP")
            #expect(value.contains("ROUND"))
            #expect(value.contains("CAP"))
            #expect(!value.contains("%@") && !value.contains("$@"))
            #expect(!value.contains("{"))
        }
        #expect(["REVIEW 2/3", "PRÜFUNG 2/3"].contains(L.t("criticbadge_round", "2", "3")))
    }
}
}
