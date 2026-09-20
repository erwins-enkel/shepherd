import Foundation
import Testing

@testable import Shepherd

/// The web's plan copy must survive catalog compilation, including positional arguments.
@MainActor
struct PlanStringsTests {
    private let plainKeys: [StaticString] = [
        "plangate_edited",
        "plangate_error",
        "plangate_menu_editor_label",
        "plangate_menu_editor_reset",
        "plangate_menu_editor_send",
        "plangate_menu_label",
        "plangate_menu_open_plan",
        "plangate_menu_rereview",
        "plangate_menu_send_changes",
        "plangate_menu_why",
        "plangate_menu_why_body",
        "plangate_planning",
        "plangate_ready",
        "plangate_repair_no_findings",
        "plangate_repair_send_failed",
        "plangate_repair_sent",
        "plangate_review_at_cap",
        "plangate_review_skipped_stalled",
        "plangate_review_started",
        "plangate_reviewing",
        "plangate_tip_changes",
        "plangate_tip_changes_stalled",
        "plangate_tip_edited",
        "plangate_tip_error",
        "plangate_tip_planning",
        "plangate_tip_ready",
        "plangate_tip_reviewing",
        "plangate_tip_view",
        "plangate_title",
        "plangate_view",
        "planpanel_back_aria",
        "planpanel_edited_note",
        "planpanel_empty",
        "planpanel_env_aria",
        "planpanel_env_docs_link",
        "planpanel_env_help_aria",
        "planpanel_env_plan",
        "planpanel_env_popover_body",
        "planpanel_env_popover_title",
        "planpanel_env_review",
        "planpanel_env_unavailable",
        "planpanel_findings",
        "planpanel_go",
        "planpanel_membrane_launch",
        "planpanel_native_go_failed",
        "planpanel_native_not_releasable",
        "planpanel_no_verdict",
        "planpanel_plan_unavailable",
        "planpanel_proposed_caption",
        "planpanel_quota_dismiss",
        "planpanel_quota_dismissing",
        "planpanel_quota_failed",
        "planpanel_quota_not_stalled",
        "planpanel_quota_resume",
        "planpanel_quota_resuming",
        "planpanel_quota_unreachable",
        "planpanel_review_already_approved",
        "planpanel_review_at_cap",
        "planpanel_review_at_cap_no_resume",
        "planpanel_review_failed",
        "planpanel_review_failed_auth",
        "planpanel_review_failed_spawn",
        "planpanel_review_failed_worktree",
        "planpanel_review_nothing_to_review",
        "planpanel_review_now",
        "planpanel_review_plan_unavailable",
        "planpanel_reviewing",
        "planpanel_status_changes",
        "planpanel_status_changes_stalled",
        "planpanel_status_edited",
        "planpanel_status_error",
        "planpanel_status_planning",
        "planpanel_status_ready",
        "planpanel_status_reviewing",
        "planpanel_status_view",
        "planpanel_title",
        "planpanel_verdict",
        "qform_freeform_placeholder",
        "qform_kind_freeform",
        "qform_kind_multi",
        "qform_kind_multi_optional",
        "qform_kind_single",
        "qform_sent",
        "qform_sent_undelivered",
        "qform_submit",
        "qform_submit_error",
        "qform_submitting",
        "vblock_apiendpoint_deprecated",
        "vblock_apiendpoint_params",
        "vblock_apiendpoint_required",
        "vblock_apiendpoint_responses",
        "vblock_callout_decision",
        "vblock_callout_info",
        "vblock_callout_risk",
        "vblock_callout_success",
        "vblock_callout_warning",
        "vblock_code_truncated",
        "vblock_datamodel_fk",
        "vblock_datamodel_nullable",
        "vblock_datamodel_pk",
        "vblock_datamodel_relations",
        "vblock_diff_highlighted_heading",
        "vblock_filetree_added",
        "vblock_filetree_modified",
        "vblock_filetree_removed",
        "vblock_filetree_renamed",
        "vblock_inferred",
        "vblock_mermaid_error",
        "vblock_mermaid_expand",
        "vblock_wireframe_mockup_label",
        "vblock_wireframe_surface_browser",
        "vblock_wireframe_surface_desktop",
        "vblock_wireframe_surface_mobile",
        "vblock_wireframe_surface_panel",
        "vblock_wireframe_surface_popover",
    ]
    private let argumentKeys: [(key: StaticString, count: Int)] = [
        ("plangate_changes", 2),
        ("plangate_repair_steer", 1),
        ("plangate_review_spends_round", 2),
        ("plangate_tip_reviewing_env", 1),
        ("planpanel_reviewing_env", 1),
        ("vblock_datamodel_was", 1),
    ]

    @Test func everyPlainKeyResolves() {
        for key in plainKeys {
            let value = L.t(key)
            #expect(!value.isEmpty)
            #expect(value != "\(key)", "Missing plan string: \(key)")
        }
    }

    @Test func argumentCarryingKeysInterpolate() {
        for (key, count) in argumentKeys {
            let value = L.t(key, "ARG_ONE", "ARG_TWO")
            #expect(value.contains("ARG_ONE"), "Missing first argument: \(key)")
            if count == 2 {
                #expect(value.contains("ARG_TWO"), "Missing second argument: \(key)")
            }
            #expect(!value.contains("%1$@"))
            #expect(!value.contains("%2$@"))
            #expect(!value.contains("{"))
        }
    }

    @Test(arguments: ["en", "de"])
    func bothBundledLocalesResolveAndPreserveArgumentOrder(locale: String) throws {
        let path = try #require(Bundle.main.path(forResource: locale, ofType: "lproj"))
        let bundle = try #require(Bundle(path: path))
        for key in plainKeys + argumentKeys.map(\.key) {
            let name = "\(key)"
            let value = bundle.localizedString(forKey: name, value: nil, table: nil)
            #expect(!value.isEmpty)
            #expect(value != name, "Missing \(locale) plan string: \(name)")
        }
        for (key, count) in argumentKeys {
            let format = bundle.localizedString(forKey: "\(key)", value: nil, table: nil)
            let value = String(format: format, locale: Locale(identifier: locale), "ARG_ONE", "ARG_TWO")
            #expect(value.contains("ARG_ONE"), "Missing \(locale) argument: \(key)")
            if count == 2 { #expect(value.contains("ARG_TWO")) }
            #expect(!value.contains("{"))
        }
        let changes = bundle.localizedString(forKey: "plangate_changes", value: nil, table: nil)
        let value = String(format: changes, locale: Locale(identifier: locale), "2", "5")
        #expect(value.contains("2/5"), "Round must precede cap in \(locale)")
    }
    @Test func goConfirmationNamesTheSession() {
        let message = L.t("planpanel_native_go_confirm", "Task Eight")
        #expect(message.contains("Task Eight"))
        #expect(!message.contains("{name}") && !message.contains("%1$@"))
    }

}
