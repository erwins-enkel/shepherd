import ShepherdKit

/// Same codes and catalog keys as the web's mergeTrainLabel and pausedText.
enum MergeOverviewCopy {
    static func automation(_ state: String?) -> String {
        switch state {
        case "merging": L.t("automerge_state_merging")
        case "rebasing": L.t("automerge_state_rebasing")
        case "merge_error": L.t("automerge_state_merge_error")
        case "rebase_cap": L.t("automerge_state_rebase_cap")
        case "stacked": L.t("automerge_state_stacked")
        default: state ?? "—"
        }
    }
    static func paused(_ state: DrainStatus) -> String {
        switch state.reason {
        case "blocked": L.t("drain_paused_blocked", state.detail ?? "")
        case "changes_requested": L.t("drain_paused_changes", state.detail ?? "")
        case "error": L.t("drain_paused_error", state.detail ?? "")
        case "usage": L.t("drain_paused_usage", state.detail ?? "")
        case "credits": L.t("drain_paused_credits")
        case "epic_base_unavailable": L.t("drain_paused_epic_base", state.detail ?? "")
        default: L.t("drain_paused_generic")
        }
    }
}
