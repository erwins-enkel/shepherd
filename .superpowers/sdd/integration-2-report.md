# Milestone 3 — wave-2 integration (S0-int)

Branch: `feat/native-wave2-integration`. Rebased onto `78fd3b67` (main, including #2422).
Delivery: one PR against main; do not merge. PR URL is recorded in the final handoff.

## Work-item outcomes

1. **Install/lifecycle:** scene installs Queues then Merge; models install Plan, Herd, Queues, Compose, Merge, then the cross-stream projections. The real installer is tested across two window passes and a seam reset: exactly one merge launcher, queue badge, composer action group and overview command, with the same activation model. Shared reset includes NewSessionSlot, all four MergeInputs, SessionSignals and scene registries.
2. **Cross-stream seams:** current-activation git/review/liveness, manual-step counts, repo-filtered Owed panel/count and notification attention are connected. Recap blocks render in the action-bar disclosure. Optional typed RelaunchRequest and archive reap bodies are declared/generated/wrapped; relaunch edits repo/branch/prompt while preserving other inherited fields, and both archive entry points use explicit leftover selection.
3. **Operator priority:** the production “+” opens ComposeSheet. Manual isolated live UI verification loaded real issues, selected #2421, observed its prompt prefill and visible engine/model/effort/capacity, and stopped before spawn. Both manual passes showed 60 reads and zero rejected requests. Added an environment-gated ShepherdUITests composer smoke and the sidebar-plus unit regression. The automated UI bundle was blocked before executing tests by automation-mode timeout, including its one retry after more than 60 seconds.
4. **Small review items:** issue search and merge status/drain-reason localization completed, including EN/DE native catalog imports; unknown capacity is now explicit. Parent accessibility identifiers discovered during the real smoke were fixed with containment. S7 stepper/heartbeat/link/headings and S8 badge/stall/focusability/unknown-block documentation were already closed by wave 1. Health-check test timing and the Kit hang safeguards were already merged; retained and rerun.
5. **Hygiene:** duplicate OpenEnum guard passes; expanded it for protocol lists, qualified protocols, comments and conditional extensions. Each stream has one production model-install call; scene-owning streams have their separate scene call. No executable `.toolbar` modifier occurs in DetailTab views. Package.resolved restored. No unrelated worktree changed.
6. **Gates:** results below. Every unit invocation removes all plain/prefixed SHEPHERD_LIVE variables; no keychain tests enabled. App/UI/live runs use the supplied shared lock. No daemon or operator process was killed. Explicit manual launches used isolated mode and normal Quit. One stalled owned xcodebuild required cancellation. A post-Quit accessibility query unexpectedly relaunched the Debug app outside isolation; that exact process was terminated. See the incident below.
7. **Delivery:** conventional lowercase commits all carry `Co-Authored-By: Codex gpt-6-astra <noreply@openai.com>`. Push with the requested `--no-verify` command, open one PR, and leave it unmerged.

## Seam table

| Seam / consumer | Source | Conservative answer |
| --- | --- | --- |
| NewSessionSlot.content | ComposeStream → ComposeSheet | Empty-slot milestone-1 preview/test fallback |
| Sidebar/action slots | Existing bar → Compose → Merge | Existing slot/fallback |
| MergeInputs.git | Current HerdSignals.git | Empty map |
| MergeInputs.reviewing | Current herd critic OR plan review | False |
| MergeInputs.planReviewBlocked | Current PlanModel review OR gate presence | True without model |
| MergeInputs.terminalEnded | Current HerdSignals.claudeAlive == false | True without model |
| SessionSignals.manualStepsOutstanding | Current MergeModel.outstanding | Empty map |
| QueuesPanels.owed / lens count | MergeOwedView / MergeRules.owed with current repo filter | Empty fallback |
| NotificationsModel.extraAttention | CI failures ∪ unanswered questions ∪ owed records | Empty; archived ids count only with actionable owed records |
| Recap blocks | Existing optional VisualBlock payload | No disclosure when absent |
| RelaunchRequest / archive reap | Changed overrides / explicitly selected leftover keys | Inherit omitted fields / reap none |

All projections reuse existing REST/push owners; none makes another request. No global closure retains an activation's model.

## Read-only safeguards and live evidence

- The activated isolated client uses ReadOnlyRequestAudit for both ordinary and long-running transports. It refuses every non-GET request and getBranchStatus, whose GET can fetch git refs. Compose suppresses that automatic probe before dispatch. Counts contain no URL, body or credential.
- Existing #2418 Up Next recomputation, PTY input/automatic reply, prompt and takeover blocks remain intact. Composer filter preferences use the isolated AppModel defaults, not the operator's standard defaults.
- Authentication/revocation uses only separate ProfileSetup clients and `Shepherd UI test (…)` token names. The audited live checks made no session creation, spawn, upload, merge, queue command or automation mutation. The separate unintended relaunch described below was not audited.
- All nine live snapshot/sign-in suites now assert positive read counts and zero rejected operations. The final run reported 14 tests in nine suites passing, including one optional pre-minted-token test skipped because its environment was absent. Thirteen tests executed successfully: 93 repositories; 1,164 issues; 186 provider-command reads; 90 branch listings (three configured repositories unavailable); 26 sessions classified; three automation snapshots; four drains; 37 build queues; 81 owed records; five plan gates; zero held/stranded tasks; 14 done sessions; 276 recaps.
- Compose, Merge and Plan verified revocation with a subsequent 401. Manual isolated app was dismissed with Escape and normal Quit, which runs its synchronous revocation handler.
- The old waitForMainWindow/sidebar failure did not reproduce in manual native accessibility: the Live window, herd groups, tallies and new composer all mounted. XCUITest did not reach that assertion because its runner could not enable automation mode. No testmanagerd restart was attempted.
- During the first manual smoke, SwiftUI parent identifiers hid the issue-row and submit-button ids; containment fixes preserve the automated test's handles. A second isolated live UI pass confirmed unique compose.sheet, compose.issue.2421, compose.prompt, compose.engine, compose.model, compose.effort, compose.capacity and compose.submit identifiers, real prefill, a ready CTA, and 60 reads / zero rejections. The CTA was not pressed.

## Gate results

- `bun run typecheck && bun run test:contract && bun run check:strings && bun run lint`: passed, including after rebase; 209 contract tests and 956 native EN/DE keys.
- `bun run check:contract-swift` and `native/scripts/sync-contract.sh --check`: passed after rebase.
- `swift test --package-path native`: 413 tests / 41 suites passed, including after rebase. Package.resolved restored.
- Debug build: passed, including the final post-rebase build.
- App unit bundle: final run passed, 1,043 tests / 109 suites. An earlier 1,042-test pass preceded the final additions. One subsequent host startup stalled and was cancelled; the next run recovered after a long startup delay and exposed a missing required liveness field in the new test fixture. Corrected the fixture, then reran the full bundle successfully.
- UI bundle: environmental failure before tests; `Timed out while enabling automation mode`. Waited more than 60 seconds and retried once; same failure. No automated composer pass claimed.
- Live model bundles: final run passed, 14 tests / nine suites (13 executed, one optional supplied-token test skipped). All executed audits passed. Manual production composer smoke passed read-only; no spawn.
- Root `bun run test`: not rerun; supplied unchanged macOS main baseline is approximately 32 failures / seven errors.

## Manual-tool isolation incident

After the second successful isolated composer smoke and normal Quit, my follow-up accessibility-state query automatically relaunched the Debug app. Process inspection showed that this new process had neither the isolated argument nor isolated environment. I terminated only that exact integration-worktree Debug process after confirming its executable path; the operator app and testmanagerd were left alone. I did not interact with the unintended instance or approve a Keychain prompt. Available process-scoped system logs did not establish whether it connected to a saved profile, so its traffic cannot be claimed as read-only. This was a deviation from the launch constraint, not part of the passing smoke evidence. No further accessibility calls were made after Quit; subsequent execution used only the isolated test wrapper.

## Remaining work for S12 or later

- Restore a working XCUITest automation service and rerun the committed UI suite; the automated gate remains unverified even though the manual composer flow succeeded.
- S12 settings/menu/usage controls; dictation/microphone and clean-terminal creation remain explicit deferrals.
- Remaining S11 presentation parity: richer source badges/previews, slow-spawn timing polish, copy/keycap feedback, steers autosave and compact-window/vertical-layout polish. Explicit Save and native scrolling remain supported.
- Relaunch currently exposes repo, base and prompt overrides; other declared run-configuration overrides retain their inherited values rather than adding another complete composer to this integration lane.
- PTY scheduling flake #2416 remains separately tracked. The package run passed; one successful run does not close a timing flake. No new blanket timeout or testmanagerd-killing preflight was added.
- Inherited Plan-tab stale-request and VoiceOver/tab-label limitations remain separate work; no new claim of exact web visual parity.
