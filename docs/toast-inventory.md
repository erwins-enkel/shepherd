# Toast inventory & lifetime policy

Audit of every `toasts.info(` call site in the UI, and the unified auto-dismiss policy
they follow. Regenerate/verify the site list with `node scripts/audit-toasts.mjs --list`
(the same script gates CI: it fails if any product call still passes the removed
`duration: null`).

## Policy

Toasts (`ui/src/lib/toasts.svelte.ts`, tone `info`) have three lifetimes, chosen by two
explicit signals — `sticky` and `alert`:

| Tier                 | Signal                               | Lifetime                                                | Countdown bar |
| -------------------- | ------------------------------------ | ------------------------------------------------------- | ------------- |
| **Must-persist**     | `sticky: true`                       | never auto-dismisses (until retried / closed / cleared) | no            |
| **Failure**          | `alert: true` (no explicit duration) | **12 000 ms** (pause on hover/focus)                    | yes           |
| **Success / notice** | neither                              | 4 000 ms                                                | yes           |
| _(explicit)_         | `duration: <ms>`                     | as given                                                | yes           |

`sticky` is the **only** way to persist — the former `duration: null` spelling was removed
so persistence is a single explicit decision (and the compiler flags any stale site).
Persist is reserved for: retry-failures the operator must act on, and tracked status
toasts that a later event clears programmatically (e.g. draft-reconcile, cleared on
success/archive). Everything else that fails is a plain `alert` (12s); dead-end failures
the operator can only read (e.g. "branch merged — relaunch instead") no longer sit on
screen forever.

## Reconciliation

`grep -rn "toasts.info(" ui/src` → 182 hits; **167 excluding `*.test.*`** (+1 `toasts.undo`,
out of scope). The classifier parses each call's own balanced argument list — a fixed
window bleeds flags between adjacent calls — and places all 167:

| Bucket                                         | Count   |
| ---------------------------------------------- | ------- |
| PERSIST (`duration:null` today → `sticky`/12s) | 71      |
| FAILURE-12s (`alert`, no duration)             | 8       |
| EXPLICIT (`duration:<ms>`)                     | 2       |
| SUCCESS/NOTICE (4s)                            | 86      |
| **Total**                                      | **167** |

Of the 71 PERSIST sites, **4 stay persistent** (`sticky: true`) — retry-failures
`+page.svelte:2225` (halt), `PlanGateBadge.svelte:115`, `SteerBar.svelte:135`, and the
tracked `store.svelte.ts:836` (draft-reconcile) — and **67 become plain 12s failures**
(strip `duration:null`, keep `alert`). Two bare-4s retry-failures are promoted to
`sticky` for consistency: `+page.svelte:2134` (decommission) and `:2303` (clear-merged).
One outlier, `Settings.svelte:1015` (session-cleanup save failure), gains `alert`+`key` to
match its 23 siblings (→ 12s).

Two classifier caveats, hand-verified: `PuiActionButton.svelte:68` has no real `action`
(the `action:` match is inside the key string `plugin-action:`) → dead-end; and
`store.svelte.ts:836`'s `key` is shorthand (`{ key, … }`) → present.

## Full site list

Target column: **sticky (A)** = stays persistent; **12s** = failure default; **4s** =
success/notice (unchanged). `*` on a `duration:null` row = becomes plain 12s unless listed
above as one of the 4 sticky / 2 promoted sites.

### ui/src/lib/components/BacklogView.svelte

| Line | Message                                                     | Signals | Today | Target |
| ---- | ----------------------------------------------------------- | ------- | ----- | ------ |
| 137  | "Doc agent didn't start (already running or nothing to do)" | —       | 4s    | 4s     |
| 139  | "Couldn't start the doc agent"                              | —       | 4s    | 4s     |

### ui/src/lib/components/BroadcastDialog.svelte

| Line | Message                                                                                    | Signals | Today | Target |
| ---- | ------------------------------------------------------------------------------------------ | ------- | ----- | ------ |
| 107  | "Broadcast steered {delivered} agents now."                                                | —       | 4s    | 4s     |
| 109  | "Broadcast · {delivered} steered now, {queued} queued on busy agents (act after current tu | —       | 4s    | 4s     |

### ui/src/lib/components/EpicHandsOffIntro.svelte

| Line | Message                                                                                    | Signals                   | Today         | Target         |
| ---- | ------------------------------------------------------------------------------------------ | ------------------------- | ------------- | -------------- |
| 74   | "Couldn't apply hands-off defaults."                                                       | duration:null, alert, key | persist(null) | 12s or sticky* |
| 86   | "Applied the defaults, but couldn't switch the epic to auto mode — set Epic mode in the co | duration:null, alert, key | persist(null) | 12s or sticky* |
| 96   | "Hands-off defaults applied."                                                              | key                       | 4s            | 4s             |

### ui/src/lib/components/EpicPanel.svelte

| Line | Message                  | Signals                   | Today         | Target         |
| ---- | ------------------------ | ------------------------- | ------------- | -------------- |
| 31   | "Epic update failed"     | duration:null, alert, key | persist(null) | 12s or sticky* |
| 80   | "Import failed"          | duration:null, alert, key | persist(null) | 12s or sticky* |
| 129  | "Epic update failed"     | duration:null, alert, key | persist(null) | 12s or sticky* |
| 145  | "Epic update failed"     | duration:null, alert, key | persist(null) | 12s or sticky* |
| 165  | "Epic update failed"     | duration:null, alert, key | persist(null) | 12s or sticky* |
| 181  | "Couldn't stop the epic" | duration:null, alert, key | persist(null) | 12s or sticky* |
| 198  | "Approve failed"         | duration:null, alert, key | persist(null) | 12s or sticky* |

### ui/src/lib/components/ExperimentPicker.svelte

| Line | Message                                        | Signals | Today    | Target  |
| ---- | ---------------------------------------------- | ------- | -------- | ------- |
| 86   | "Could not start that run — please try again." | alert   | 4s+alert | 12s (C) |

### ui/src/lib/components/GitRail.svelte

| Line | Message                                                                        | Signals                   | Today         | Target         |
| ---- | ------------------------------------------------------------------------------ | ------------------------- | ------------- | -------------- |
| 314  | `text`                                                                         | —                         | 4s            | 4s             |
| 318  | `text`                                                                         | duration:15, action, key  | 15ms          | 15ms           |
| 513  | "Review not started — conditions changed or one's already running."            | —                         | 4s            | 4s             |
| 515  | "Couldn't start the review. Try again."                                        | duration:null, alert, key | persist(null) | 12s or sticky* |
| 521  | "Couldn't start the review. Try again."                                        | duration:null, alert, key | persist(null) | 12s or sticky* |
| 538  | "Plan review not started: .shepherd-plan.md is missing, empty, or unreadable." | —                         | 4s            | 4s             |
| 540  | "Couldn't start a plan review right now."                                      | —                         | 4s            | 4s             |
| 542  | "Couldn't start the plan review. Try again."                                   | duration:null, alert, key | persist(null) | 12s or sticky* |
| 548  | "Couldn't start the plan review. Try again."                                   | duration:null, alert, key | persist(null) | 12s or sticky* |

### ui/src/lib/components/NewTask.svelte

| Line | Message                       | Signals | Today    | Target  |
| ---- | ----------------------------- | ------- | -------- | ------- |
| 290  | "Synced {name} with upstream" | —       | 4s       | 4s      |
| 293  | `syncForkMsg(code)`           | alert   | 4s+alert | 12s (C) |

### ui/src/lib/components/page/AppOverlays.svelte

| Line | Message                                          | Signals | Today | Target |
| ---- | ------------------------------------------------ | ------- | ----- | ------ |
| 365  | "Distiller started for {repo}"                   | —       | 4s    | 4s     |
| 370  | "Opened a CLAUDE.md PR for the rule"             | —       | 4s    | 4s     |
| 373  | "Could not promote the rule; see the server log" | —       | 4s    | 4s     |
| 376  | "Optimizing flagged rules…"                      | —       | 4s    | 4s     |
| 377  | "Couldn’t start optimization"                    | —       | 4s    | 4s     |
| 380  | "Optimizing flagged rules…"                      | —       | 4s    | 4s     |
| 381  | "Couldn’t start optimization"                    | —       | 4s    | 4s     |
| 385  | "Couldn't restore rule"                          | —       | 4s    | 4s     |
| 389  | "Couldn't revert the trial — try again."         | key     | 4s    | 4s     |
| 393  | "Couldn't update scope"                          | —       | 4s    | 4s     |
| 401  | "Rules consolidated"                             | —       | 4s    | 4s     |
| 404  | "Couldn't merge rules"                           | —       | 4s    | 4s     |
| 412  | "Rule added to your global CLAUDE.md."           | —       | 4s    | 4s     |
| 415  | "Couldn't write to your global CLAUDE.md."       | —       | 4s    | 4s     |
| 418  | "Looking for rules to merge in {repo}…"          | —       | 4s    | 4s     |

### ui/src/lib/components/PlanGateBadge.svelte

| Line | Message                                                                        | Signals                           | Today         | Target         |
| ---- | ------------------------------------------------------------------------------ | --------------------------------- | ------------- | -------------- |
| 113  | "Plan changes sent to the agent."                                              | key                               | 4s            | 4s             |
| 115  | "Couldn't send the plan changes to the agent."                                 | duration:null, alert, action, key | persist(null) | **sticky** (A) |
| 131  | "Plan review started."                                                         | —                                 | 4s            | 4s             |
| 133  | "Plan review not started: .shepherd-plan.md is missing, empty, or unreadable." | —                                 | 4s            | 4s             |
| 135  | "Couldn't start a plan review right now."                                      | —                                 | 4s            | 4s             |
| 137  | "Couldn't start the plan review. Try again."                                   | duration:null, alert, key         | persist(null) | 12s or sticky* |
| 144  | "Couldn't start the plan review. Try again."                                   | duration:null, alert, key         | persist(null) | 12s or sticky* |

### ui/src/lib/components/PrBadge.svelte

| Line | Message                                                               | Signals                   | Today         | Target         |
| ---- | --------------------------------------------------------------------- | ------------------------- | ------------- | -------------- |
| 80   | "PR #{number} merged"                                                 | key                       | 4s            | 4s             |
| 82   | "Merge failed: {reason}. Check the PR, then retry." / "unknown error" | duration:null, alert, key | persist(null) | 12s or sticky* |
| 100  | "PR marked as Draft" / "PR marked Ready for Review"                   | key                       | 4s            | 4s             |
| 104  | "Couldn't change PR state: {reason}" / "unknown error"                | duration:null, alert, key | persist(null) | 12s or sticky* |

### ui/src/lib/components/ReadinessPanel.svelte

| Line | Message                                                                                  | Signals                   | Today         | Target         |
| ---- | ---------------------------------------------------------------------------------------- | ------------------------- | ------------- | -------------- |
| 162  | "Opened a PR adding .shepherd-* to .gitignore: {url}"                                    | action, key               | 4s            | 4s             |
| 172  | ".shepherd-* is already in .gitignore."                                                  | key                       | 4s            | 4s             |
| 176  | "No git forge configured; session artifacts are already hidden locally via git exclude." | key                       | 4s            | 4s             |
| 180  | "No push access; session artifacts are already hidden locally via git exclude."          | key                       | 4s            | 4s             |
| 188  | "Couldn't update .gitignore. Try again."                                                 | duration:null, alert, key | persist(null) | 12s or sticky* |

### ui/src/lib/components/RetryDialog.svelte

| Line | Message                                                        | Signals | Today | Target |
| ---- | -------------------------------------------------------------- | ------- | ----- | ------ |
| 67   | "Retry sent · {resumed} resumed · {steered} steered / {total}" | —       | 4s    | 4s     |

### ui/src/lib/components/Settings.svelte

| Line | Message                                                  | Signals                   | Today         | Target         |
| ---- | -------------------------------------------------------- | ------------------------- | ------------- | -------------- |
| 433  | "Couldn't change the role environment. Retry."           | duration:null, alert, key | persist(null) | 12s or sticky* |
| 453  | "Couldn't change the role environment. Retry."           | duration:null, alert, key | persist(null) | 12s or sticky* |
| 471  | "Couldn't change the role environment. Retry."           | duration:null, alert, key | persist(null) | 12s or sticky* |
| 553  | "Couldn't change PR review cycles. Retry."               | duration:null, alert, key | persist(null) | 12s or sticky* |
| 581  | "Couldn't change plan review cycles. Retry."             | duration:null, alert, key | persist(null) | 12s or sticky* |
| 602  | "Couldn't change default model. Retry."                  | duration:null, alert, key | persist(null) | 12s or sticky* |
| 621  | "Couldn't change default effort. Retry."                 | duration:null, alert, key | persist(null) | 12s or sticky* |
| 640  | "Couldn't save the operator language."                   | duration:null, alert, key | persist(null) | 12s or sticky* |
| 659  | "Couldn't change default coding CLI. Retry."             | duration:null, alert, key | persist(null) | 12s or sticky* |
| 685  | "Couldn't update authentication mode"                    | duration:null, alert, key | persist(null) | 12s or sticky* |
| 705  | "Couldn't save the API key"                              | duration:null, alert, key | persist(null) | 12s or sticky* |
| 753  | "Couldn't save the API key"                              | duration:null, alert, key | persist(null) | 12s or sticky* |
| 779  | "Couldn't change the extra-credit spend ceiling. Retry." | duration:null, alert, key | persist(null) | 12s or sticky* |
| 797  | "Couldn't change the Up Next picker setting. Retry."     | duration:null, alert, key | persist(null) | 12s or sticky* |
| 815  | "Couldn't change usage hold setting. Retry."             | duration:null, alert, key | persist(null) | 12s or sticky* |
| 833  | "Couldn't update Fable availability"                     | duration:null, alert, key | persist(null) | 12s or sticky* |
| 850  | "Couldn't change the fullscreen renderer setting."       | duration:null, alert, key | persist(null) | 12s or sticky* |
| 867  | "Couldn't change the mouse-capture setting."             | duration:null, alert, key | persist(null) | 12s or sticky* |
| 884  | "Couldn't save reduced notifications setting."           | duration:null, alert, key | persist(null) | 12s or sticky* |
| 902  | "Couldn't save the telemetry setting."                   | duration:null, alert, key | persist(null) | 12s or sticky* |
| 924  | "Couldn't change the usage hold threshold. Retry."       | duration:null, alert, key | persist(null) | 12s or sticky* |
| 942  | "Couldn't change the usage downgrade setting. Retry."    | duration:null, alert, key | persist(null) | 12s or sticky* |
| 964  | "Couldn't change the usage downgrade threshold. Retry."  | duration:null, alert, key | persist(null) | 12s or sticky* |
| 983  | "Couldn't change the downgrade model. Retry."            | duration:null, alert, key | persist(null) | 12s or sticky* |
| 1015 | "Couldn't change session cleanup. Retry."                | —                         | 4s            | 4s             |

### ui/src/lib/components/settings/SettingsDiagnosePanel.svelte

| Line | Message                                                                                    | Signals                   | Today         | Target         |
| ---- | ------------------------------------------------------------------------------------------ | ------------------------- | ------------- | -------------- |
| 48   | "Fixed — re-checked."                                                                      | duration:3000             | 3000ms        | 3000ms         |
| 50   | "The command ran, but the check is still not OK — it may need a manual step or a restart." | duration:null, alert, key | persist(null) | 12s or sticky* |
| 57   | "Fix failed — the command did not complete. Try running it manually."                      | duration:null, alert, key | persist(null) | 12s or sticky* |

### ui/src/lib/components/StarPrompt.svelte

| Line | Message               | Signals | Today | Target |
| ---- | --------------------- | ------- | ----- | ------ |
| 28   | "Starred. Thank you!" | key     | 4s    | 4s     |

### ui/src/lib/components/SteerBar.svelte

| Line | Message       | Signals                           | Today         | Target         |
| ---- | ------------- | --------------------------------- | ------------- | -------------- |
| 135  | "send failed" | duration:null, alert, action, key | persist(null) | **sticky** (A) |

### ui/src/lib/components/UnitRow.svelte

| Line | Message                                                                        | Signals                   | Today         | Target         |
| ---- | ------------------------------------------------------------------------------ | ------------------------- | ------------- | -------------- |
| 372  | "Couldn't start execution. Try again."                                         | duration:null, alert, key | persist(null) | 12s or sticky* |
| 379  | "Couldn't start execution. Try again."                                         | duration:null, alert, key | persist(null) | 12s or sticky* |
| 394  | "Plan review started."                                                         | —                         | 4s            | 4s             |
| 396  | "Plan review not started: .shepherd-plan.md is missing, empty, or unreadable." | —                         | 4s            | 4s             |
| 398  | "Couldn't start a plan review right now."                                      | —                         | 4s            | 4s             |
| 400  | "Couldn't start the plan review. Try again."                                   | duration:null, alert, key | persist(null) | 12s or sticky* |
| 406  | "Couldn't start the plan review. Try again."                                   | duration:null, alert, key | persist(null) | 12s or sticky* |
| 423  | "Couldn't resume the plan review. Try again."                                  | —                         | 4s            | 4s             |
| 425  | "Couldn't resume the plan review. Try again."                                  | —                         | 4s            | 4s             |
| 440  | "Re-running the failed CI jobs…"                                               | —                         | 4s            | 4s             |
| 441  | "Retrying CI isn't available for this repo's forge."                           | —                         | 4s            | 4s             |
| 442  | "No failed CI run found to retry."                                             | —                         | 4s            | 4s             |
| 444  | "Couldn't retry CI. Try again."                                                | duration:null, alert, key | persist(null) | 12s or sticky* |
| 541  | "Couldn't resume {name}"                                                       | —                         | 4s            | 4s             |

### ui/src/lib/components/UpNextPanel.svelte

| Line | Message                                   | Signals                   | Today         | Target         |
| ---- | ----------------------------------------- | ------------------------- | ------------- | -------------- |
| 288  | "Started {count} session(s)"              | key                       | 4s            | 4s             |
| 291  | "Held {count} task(s) until usage resets" | key                       | 4s            | 4s             |
| 295  | "Couldn't start {count} item(s)"          | duration:null, alert, key | persist(null) | 12s or sticky* |
| 302  | "Couldn't start {count} item(s)"          | duration:null, alert, key | persist(null) | 12s or sticky* |
| 311  | "Couldn't start {count} item(s)"          | duration:null, alert, key | persist(null) | 12s or sticky* |

### ui/src/lib/components/Viewport.svelte

| Line | Message                                                                           | Signals                   | Today         | Target         |
| ---- | --------------------------------------------------------------------------------- | ------------------------- | ------------- | -------------- |
| 791  | "Couldn't change autopilot for this session. Try again."                          | —                         | 4s            | 4s             |
| 1189 | "Couldn't stop the dev server; it may be ignoring the stop signal."               | duration:null, alert, key | persist(null) | 12s or sticky* |
| 1221 | "Stopped the dev server for {name}"                                               | —                         | 4s            | 4s             |
| 1230 | "Couldn't stop the dev server; it may be ignoring the stop signal."               | duration:null, alert, key | persist(null) | 12s or sticky* |
| 1241 | "No running dev-server process was found to stop; the preview is still attached." | duration:null, alert, key | persist(null) | 12s or sticky* |
| 1251 | "Stopping dev server…"                                                            | —                         | 4s            | 4s             |
| 1605 | "Copied to clipboard"                                                             | —                         | 4s            | 4s             |
| 2760 | "Copied to clipboard"                                                             | —                         | 4s            | 4s             |
| 2765 | "Couldn’t copy to clipboard"                                                      | alert                     | 4s+alert      | 12s (C)        |

### ui/src/lib/components/viewport/ViewportTabBar.svelte

| Line | Message                                                                                   | Signals                   | Today         | Target         |
| ---- | ----------------------------------------------------------------------------------------- | ------------------------- | ------------- | -------------- |
| 102  | "Couldn't start preview; check terminal for details"                                      | duration:null, alert, key | persist(null) | 12s or sticky* |
| 119  | "Preview is already live"                                                                 | —                         | 4s            | 4s             |
| 124  | "Dev server is already running; opening preview"                                          | —                         | 4s            | 4s             |
| 130  | "Preview setup sent to {name}; future starts will use the local repo script"              | —                         | 4s            | 4s             |
| 136  | "Preview script started for {name} ({command})" / "Preview start sent to {name} (running: | —                         | 4s            | 4s             |

### ui/src/lib/plugin-ui/PuiActionButton.svelte

| Line | Message                | Signals                   | Today         | Target         |
| ---- | ---------------------- | ------------------------- | ------------- | -------------- |
| 66   | "Done"                 | —                         | 4s            | 4s             |
| 68   | "Plugin action failed" | duration:null, alert, key | persist(null) | 12s or sticky* |

### ui/src/lib/pull-offer.ts

| Line | Message                                                                  | Signals                   | Today         | Target         |
| ---- | ------------------------------------------------------------------------ | ------------------------- | ------------- | -------------- |
| 11   | "Updated local {branch} to latest" / "Local {branch} already up to date" | —                         | 4s            | 4s             |
| 23   | "Local checkout isn't on {branch}; left it untouched"                    | —                         | 4s            | 4s             |
| 26   | "Local {branch} has uncommitted changes; left it untouched"              | —                         | 4s            | 4s             |
| 29   | "Local {branch} has diverged; pull manually"                             | —                         | 4s            | 4s             |
| 33   | "Couldn't update local checkout"                                         | duration:null, alert, key | persist(null) | 12s or sticky* |

### ui/src/lib/store.svelte.ts

| Line | Message                                                                                    | Signals                   | Today         | Target         |
| ---- | ------------------------------------------------------------------------------------------ | ------------------------- | ------------- | -------------- |
| 366  | "Renamed to {name}"                                                                        | —                         | 4s            | 4s             |
| 492  | "Blocked egress to {host}"                                                                 | alert, key                | 4s+alert      | 12s (C)        |
| 498  | "{count} attached file(s) expired and could not be restored. The session started without t | alert, key                | 4s+alert      | 12s (C)        |
| 504  | "Heads up: issue content for a session tripped {count} prompt-injection check(s). It is fe | alert, key                | 4s+alert      | 12s (C)        |
| 510  | "Auto-drain skipped issue #{issue}: its author is not a trusted repo member, so Shepherd w | alert, key                | 4s+alert      | 12s (C)        |
| 647  | "{repo}: doc-update PR opened"                                                             | action, key               | 4s            | 4s             |
| 659  | "{repo}: doc-agent observe run — no PR opened"                                             | —                         | 4s            | 4s             |
| 661  | "{repo}: doc update aborted — prettier couldn't format the docs"                           | duration:null, alert, key | persist(null) | 12s or sticky* |
| 667  | "{repo}: docs already current"                                                             | —                         | 4s            | 4s             |
| 695  | "Epic #{number} landed — merged to the default branch"                                     | key                       | 4s            | 4s             |
| 699  | "Epic #{number} complete — {count} sub-issues landed"                                      | key                       | 4s            | 4s             |
| 801  | "Halted {count} agents"                                                                    | key                       | 4s            | 4s             |
| 817  | "Merge train landed in {repo}"                                                             | key                       | 4s            | 4s             |
| 836  | `text`                                                                                     | duration:null, alert, key | persist(null) | 12s or sticky* |

### ui/src/routes/+page.svelte

| Line | Message                                                                 | Signals                           | Today         | Target         |
| ---- | ----------------------------------------------------------------------- | --------------------------------- | ------------- | -------------- |
| 1028 | "No ready-to-merge PRs to run a merge train on"                         | —                                 | 4s            | 4s             |
| 1051 | "Couldn't start the merge train"                                        | —                                 | 4s            | 4s             |
| 1084 | "Couldn't start the merge train"                                        | —                                 | 4s            | 4s             |
| 1901 | `(NEW_PROJECT_WARNINGS[entry.warning] ?? m.newproject_warning`          | —                                 | 4s            | 4s             |
| 1958 | "Relaunched as {desig}"                                                 | —                                 | 4s            | 4s             |
| 1961 | "Relaunched, but couldn't decommission the original; close it manually" | duration:null, alert, key         | persist(null) | 12s or sticky* |
| 1996 | "Held task updated."                                                    | —                                 | 4s            | 4s             |
| 2028 | "Task held — usage is high. It'll start when usage resets."             | —                                 | 4s            | 4s             |
| 2059 | "Couldn't load the original's attachments. Re-attach them if needed."   | alert                             | 4s+alert      | 12s (C)        |
| 2134 | "Couldn't decommission {name}"                                          | action                            | 4s            | —              |
| 2153 | `text`                                                                  | duration:null, alert, key         | persist(null) | 12s or sticky* |
| 2156 | "Relaunched as {desig}"                                                 | —                                 | 4s            | 4s             |
| 2190 | `text`                                                                  | duration:null, alert, key         | persist(null) | 12s or sticky* |
| 2194 | "Brought {desig} back to the herd"                                      | —                                 | 4s            | 4s             |
| 2223 | "Halting {count} running agents…"                                       | key                               | 4s            | 4s             |
| 2225 | "Halt failed: no agents interrupted. Retry."                            | duration:null, alert, action, key | persist(null) | **sticky** (A) |
| 2256 | "Done"                                                                  | —                                 | 4s            | 4s             |
| 2258 | "Plugin action failed"                                                  | duration:null, alert, key         | persist(null) | 12s or sticky* |
| 2284 | "Couldn't decommission merged sessions"                                 | —                                 | 4s            | 4s             |
| 2301 | "Decommissioned {count} merged sessions"                                | —                                 | 4s            | 4s             |
| 2303 | "Couldn't decommission merged sessions"                                 | action                            | 4s            | —              |
| 2327 | "Couldn't dismiss the epic — try again"                                 | duration:null, alert, key         | persist(null) | 12s or sticky* |
| 2347 | "Couldn't acknowledge the migrations — try again"                       | duration:null, alert, key         | persist(null) | 12s or sticky* |
| 2363 | "Couldn't acknowledge the manual steps — try again."                    | duration:null, alert, key         | persist(null) | 12s or sticky* |
| 2415 | `msg`                                                                   | duration:null, alert, key         | persist(null) | 12s or sticky* |
