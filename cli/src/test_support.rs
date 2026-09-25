//! Fixtures shared by unit and integration tests. Not part of the CLI's behavior.

use serde_json::{Value, json};

/// A minimal contract-valid `Session` body.
pub fn session_json(id: &str, desig: &str) -> Value {
    json!({
        "id": id, "desig": desig, "name": format!("{desig} name"), "prompt": "do it",
        "repoPath": "/work/repo", "baseBranch": "main", "branch": format!("shepherd/{desig}"),
        "worktreePath": "/work/wt", "isolated": true, "herdrSession": "s", "herdrAgentId": "a",
        "claudeSessionId": "c", "model": null, "effort": null, "readyToMerge": false,
        "mergingSince": null, "autopilotEnabled": null, "autopilotPaused": false,
        "autopilotComplete": false, "planGateEnabled": null, "planPhase": null,
        "autoMergeEnabled": null, "auto": false, "issueNumber": null, "sandboxApplied": null,
        "status": "running", "lastState": "working", "createdAt": 0, "updatedAt": 0,
        "archivedAt": null, "haltReason": null, "haltedAt": null, "manualSteps": []
    })
}

/// A contract-valid `RepoConfig` body (`PUT /api/repo-config` answers it).
pub fn repo_config_json() -> Value {
    let mut v = json!({
        "signoffAuthority": "operator", "maxAuto": 2, "autoLabel": "shepherd",
        "usageCeilingPct": 90, "sandboxProfile": "standard", "defaultModel": "",
        "defaultEffort": "", "egressExtraHosts": [], "repoMode": "forge",
        "previewOpenMode": "tab"
    });
    for flag in [
        "criticEnabled",
        "criticAllPrs",
        "criticSmellLensEnabled",
        "autoAddressEnabled",
        "learningsEnabled",
        "autopilotEnabled",
        "planGateEnabled",
        "autoDrainEnabled",
        "autoMergeEnabled",
        "buildQueueEnabled",
        "draftMode",
        "autoOptimizeFlagged",
        "manualStepsIssueEnabled",
        "preWarmEpicLandingCi",
        "epicStacksEnabled",
        "hidden",
    ] {
        v[flag] = json!(false);
    }
    v
}
