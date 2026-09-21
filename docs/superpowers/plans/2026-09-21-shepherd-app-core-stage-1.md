# ShepherdAppCore — Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Extract the approved shared application layer into ShepherdAppCore, preserving Mac behavior and all existing scenarios while building and running shared tests on macOS and iOS Simulator.

**Architecture:** A new library and test target inside the existing ShepherdKit package hold models, rules, registries, lifecycle and localized resources. The Mac app supplies synchronous notification/focus dependencies and named presentation hooks; all view bodies, local-server hosting and SwiftTerm remain Mac-owned. Move the cyclic AppModel/extension/registry graph together, including resource plumbing and test migration, before taking another implementation checkpoint.

**Tech Stack:** Swift tools 6.1, Swift language mode 6, complete strict concurrency and ExistentialAny; execution toolchain Swift 6.2+; Foundation, Observation, SwiftUI, os, existing ShepherdKit/OpenAPI dependencies; XcodeGen, Swift Testing, XCTest, Bun, GitHub Actions. No new dependencies.

**Spec:** docs/superpowers/specs/2026-09-21-shepherd-app-core-stage-1-design.md — approved by operator “go”, including both existing-ShepherdKit exceptions. Issue instructions: .superpowers/sdd/issue-2431.md. Tasks 1–4 are implemented and independently reviewed; Task 5 is reconciling this plan with recorded evidence. Aggregate acceptance remains unmet pending root, live and hosted gates.

## Global Constraints

- “Every view body remains in the Mac target in Stage 1”, including AppKit-free bodies.
- “Keep package identity, existing ShepherdKit sources/product, existing dependencies and platform floors.” Identity ShepherdKit; macOS 15 / iOS 18; Mac project/Info.plist macOS 15.0; SwiftTerm exactly 1.20.0 stays app-only.
- “No new @unchecked Sendable, nonisolated(unsafe) or concurrency-suppressing annotation.” Preserve documented test URLProtocol stubs and approved unchanged Kit annotations in Credentials/InMemoryCredentialStore.swift and Client/ReadOnlyRequestAudit.swift.
- Preserve only existing isolated **Kit CI** Keychain coverage. Never opt local/core/simulator tests in with SHEPHERD_KEYCHAIN_TESTS or TEST_RUNNER_SHEPHERD_KEYCHAIN_TESTS; no Keychain prompts.
- “Use git mv for whole-file moves.” Preserve algorithms, transitions, persistence keys, timing, cancellation, error handling and presentation; declaration splits are extraction, not redesign.
- “Core may use SwiftUI types in existing contracts (AnyView, Color, EventModifiers), but must not import AppKit/UIKit, SwiftTerm, the app module, or use Mac-only symbols through transitive imports.”
- Preserve @MainActor, @Sendable, nonisolated constants, @Observable, @ObservationIgnored, final classes and private setters. Public API follows app consumers; tests use @testable, never broaden production mutation for test convenience.
- Bundle.main remains AppModel.appVersion's consuming-app source. Only localized copy uses Bundle.module; keep run.shepherd.mac persistence/credential/log identities.
- Contract-first; no payload redefinitions, schema changes, second socket, container/plugin framework, Kit fork, platform stubs or #if os(macOS) hiding core implementations.
- L.t only, EN + DE catalogs and existing manifests; generator emits module xcstrings and two runtime .strings files from one conversion result.
- Preserve **1,090 app @Test declarations, 416 Kit @Test declarations and 13 UI methods** by identity/scenario; new tests count separately. These are source counts, not runtime totals.
- All xcodebuild entry points use uitest-lock.sh, including indirect scripts and discovery/version queries. One foreground command/run/review at a time; no agents, background work, parallel jobs or stale milestone stream templates.
- “Never launch the app outside isolated mode for automated checks.” Live smoke uses only operator-supplied environment, existing authentication/test-token lifecycle and audited reads; no queue recomputation, terminal input or getBranchStatus fetch side effects. Never read/print settings.local.json or secrets.
- “Never use bare bun test.” Use bun run test and bun run test:contract; output at most filtered errors/results or last 40 lines with failure preserved. Reads ≤300 lines; never read generated files/logs whole.
- Missing secrets, signing prerequisites, toolchain, simulator or executing tests are **UNMET** gates, never accepted skips. No acceptance reduction or unreviewed Kit rewrite.
- origin/main ancestry, rebase-only updates, one Stage 1 PR, green-only squash merge. Never force-add .superpowers. No Stage 2 iOS app, shared views, deployment, signing-policy changes or parity features.

## Review Focus

1. A profile switches while activation or a selected-session action is suspended: outgoing work cannot write into the new activation. Task 2: preserved AppExtensionTests.anActivationSupersededOnTheCredentialProbeBuildsNoExtension and new CurrentSelectionTests.rejectsDifferentStoreAndSelection.
2. Focus changes twice while authorization is suspended, followed by teardown: synchronous initial sample, both transitions and final current focus survive; observation is removed and badge clear submitted before incoming writes. Task 2: NotificationHostTests.focusTransitionsDuringAuthorizationAndTeardown, existing NotificationsBadgeRaceTests and teardown-clear test.
3. Reset after composed slots and overridden prompt installation, then two full installs: built-in prompt renderer survives, conservative defaults return, owners release and integrated owed panel wins each pass. Task 2: CoreInstallationTests.resetKeepsPromptHost and MacCoreCompositionTests.resetThenRepeatedProductionPasses.
4. Reordered arguments, quotes, backslashes, controls and literal percent signs: generated resources agree and both platform bundles resolve every EN/DE key without checkout paths. Task 3: generator escaping/reordering cases and CoreResourceTests.everyCatalogEntryResolvesInBothLocales.
5. A mixed suite splits or a filter matches zero tests: no old identity/assertion disappears behind unchanged totals, parameterized cases/skips stay visible, and zero execution fails. Task 1: conservation omission/duplicate/replacement tests; Task 4: simulator count and destination-selection negative tests.

---

## Sequential execution and task boundaries

The method is already selected. After written-plan approval, use fresh codex-run.sh per implementation task, then a fresh per-task review; wait for its verdict before the next run. The orchestrator dispatches, reads verdicts and handles final merge; it does not implement product changes. The skill header does not authorize in-process agents or parallel work.

| Task | Implementation tier | Review tier | Independently reviewable result |
| --- | --- | --- | --- |
| 1 | std — gpt-6-astra / medium | std | Baseline identities, conservation checker and unchanged-base evidence |
| 2 | deep — gpt-6-astra / high | deep | Complete buildable extraction, Mac adapters, resources and migrated tests |
| 3 | mid — gpt-5.6-luna / medium | std | Adversarial localization/bundle tests |
| 4 | deep — gpt-6-astra / high | deep | Blocking simulator CI, isolated Kit/core lanes, final native/live evidence |
| 5 | light — gpt-5.6-sol / low | std | Documentation and acceptance evidence match the extraction |
| 6 | deep — gpt-6-astra / high | deep | Whole-branch review, sequential fixes/review, single PR and merge handoff |

Dependency order is strictly Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6; each task waits for its fresh review verdict.

Task 2 is deliberately larger: moving only AppModel or only extensions leaves reverse registry/model dependencies, notification defaults, prompt construction and Mac imports broken. Resource plumbing belongs here because a compiling app with missing copy is not an acceptable checkpoint. Task 3 is separately rejectable tests-only hardening, not deferred basic correctness. Task 4 owns CI/semantic integration, not repetition of earlier successful gates. Task 5 is mechanical; lifecycle/API defects go to a fresh deep fix run.

Dispatch after approval only, in foreground:

~~~bash
set -euo pipefail
RUNNER=/Users/kai.osthoff/.claude/projects/-Users-kai-osthoff-githubrepos-shepherd/tools/codex-run.sh
export CODEX_LIGHT_MODEL=gpt-5.6-sol CODEX_MID_MODEL=gpt-5.6-luna
TASK=1
TIER=std
WORKTREE="$PWD"
BRIEF="$PWD/.superpowers/sdd/issue-2431-task-$TASK.md"
RUN_LOG="$PWD/.superpowers/sdd/issue-2431-task-$TASK.log"
"$RUNNER" "$TIER" implement "$WORKTREE" "$BRIEF" "$RUN_LOG"
REVIEW_BRIEF="$PWD/.superpowers/sdd/issue-2431-task-$TASK-review.md"
REVIEW_LOG="$PWD/.superpowers/sdd/issue-2431-task-$TASK-review.log"
"$RUNNER" std review "$WORKTREE" "$REVIEW_BRIEF" "$REVIEW_LOG"
~~~

Set TASK/TIER from the table; Tasks 2/4/6 use deep review. Each brief contains the whole owning task, constraints, spec path, predecessor SHA/verdict, signatures below and evidence index. Write #2431 briefs directly: m3 templates' parallel streams, file ownership and repeated gates are overridden.

Each run reports commit SHA, files/declarations moved, identity changes, commands/exit codes, pass/skip/failure/parameterized counts, environment class, evidence paths, risks and PASS/FAIL/UNMET. Store concise .superpowers/sdd/issue-2431-task-N-report.md reports without force-adding them. Result bundles stay outside tracked source.

Reviewers reuse implementer/CI evidence keyed by tested SHA and relevant file changes. Never repeat passed full gates without a change or concrete doubt. A rejection triggers a fresh appropriate-tier implementation fix, then fresh review, sequentially. For Task 6 the review brief explicitly grants scoped fixes; runner review mode's usual read-only contract is overridden only there.

## File structure and exact relocation map

S = native/Apps/ShepherdMac/Sources; C = native/Sources/ShepherdAppCore. Every relative path expands literally beneath its root. Task 2 owns all production moves/splits below. No wildcard authorizes moving unlisted views.

Whole-file S/path → C/path moves (git mv):

| Directory | Exact filenames |
| --- | --- |
| App | AppModel.swift, AppModel+Extensions.swift, ProfileStore.swift, SessionSignals.swift, ShepherdErrorCopy.swift, Log.swift, L.swift, SidebarSlot.swift, WelcomeSlots.swift, ActionBarSlot.swift, NewSessionSlot.swift |
| Sidebar | SidebarModel.swift, HerdPartition.swift, SidebarCopy.swift |
| Detail | DetailModel.swift, UnifiedPatch.swift, DiffAnnotationLayout.swift |
| Actions | ActionsModel.swift, ActionRules.swift, ActionErrorCopy.swift |
| Herd | HerdSignals.swift, HerdClassifier.swift, HerdStream.swift |
| Plan | PlanModel.swift, PlanGateChip.swift |
| Queues | QueuesModel.swift |
| Compose | ComposeModel.swift, ComposeSubmission.swift, RepoBranchModel.swift, ShapeRoundModel.swift, AttachmentModel.swift, IssueFilter.swift |
| Merge | MergeModel.swift, MergeRules.swift, MergeConfirmationRules.swift, MergeOverviewCopy.swift |
| Settings | SettingsModel.swift, SettingsTokensModel.swift, SettingsReadyModel.swift, SettingsDiagnosticCopy.swift |
| Notifications | NotificationSettings.swift, NotificationCopy.swift, NotificationGate.swift, NotificationTrigger.swift, NotificationsStream.swift |
| Terminal | TerminalController.swift, TerminalSessionModel.swift, PTYAttaching.swift, ConnectingOverlayDebouncer.swift |
| Main | SessionStatusStyle.swift, PreviewData.swift |

Keep PreviewData DEBUG-only and all supporting declarations, including AppSheet/RemoteServerForm/ConnectionSource/ProbeGate, Loaded/DetailFeed, HerdBindings, NewSessionExtras, settings notification/ready rules, PTYCommandQueue/LivePTYAttachment.

Declaration splits: move named non-view declarations to C destination, leaving views in S source. Preserve implementation text except explicit seam/import/access changes.

| S source | C destination | Declarations |
| --- | --- | --- |
| App/DetailTabs.swift | App/DetailTabs.swift | DetailTab, PromptDetailTab metadata, DetailTabRegistry |
| App/CommandRegistry.swift | App/CommandRegistry.swift | MenuCommand, Shortcut, CommandRegistry |
| App/SettingsScene.swift | App/SettingsPaneRegistry.swift | SettingsPane, SettingsPaneRegistry |
| App/StreamRegistrations.swift | App/StreamRegistrations.swift | Installation and fixed order; S replacement MacStreamHost.swift |
| App/Wave2Seams.swift | App/Wave2Seams.swift | Neutral connect statements; panel stays Mac |
| Notifications/NotificationsModel.swift | Notifications/NotificationsModel.swift | Model after injection; S replacement MacNotificationEnvironment.swift |
| Notifications/NotificationCenterClient.swift | Notifications/NotificationCenterClient.swift | Request, authorization, client protocol, FakeNotificationCenter; SystemNotificationCenter/ResponseDelegate stay |
| Main/MainWindow.swift | Main/SessionCommandState.swift | SessionCommandState, NoticeTone |
| Main/NewSessionSheet.swift | Main/NewSessionSubmission.swift | NewSessionSubmission, ProviderSelection |
| Welcome/FirstRunSheet.swift | Welcome/FirstRunSubmission.swift | FirstRunSubmission |
| Welcome/LoginSheet.swift | Welcome/LoginSheetState.swift | LoginSheetState |
| Main/ConnectionBanner.swift | Main/BannerPolicy.swift | BannerKind, SemanticVersion, AppVersion, BannerPolicy |
| Actions/ActionBarView.swift | Actions/ActionBarState.swift | RecapLine, ActionNote, ActionBarOutcome, CurrentSessionSelection helper |
| Actions/RenameSheet.swift | Actions/RenameSubmission.swift | RenameSubmission |
| Actions/AmendSheet.swift | Actions/AmendSubmission.swift | AmendSubmission |
| Detail/DetailFeature.swift | Detail/DetailFeature.swift | Model registration, DetailTaskKey, DetailStatePhase |
| Detail/FilesTabView.swift | Detail/FilesBreadcrumb.swift | FilesBreadcrumb |
| Detail/GitTabView.swift | Detail/GitPanelRules.swift | GitPanelRules |
| Header/UsageMeter.swift | Header/UsageMeter.swift | UsageBar, UsageMeter |
| Sidebar/SessionBadges.swift | Sidebar/SessionBadges.swift | Badge descriptors/rules only |
| Herd/HerdStepper.swift | Herd/HerdStepper.swift | HerdStepperSegment, HerdStepper |
| Herd/HerdRowGit.swift | Herd/HerdHeartbeat.swift | HerdHeartbeat |
| Plan/PlanStream.swift | Plan/PlanStream.swift | PlanSignals, registration/signals |
| Plan/PlanTabView.swift | Plan/PlanTabState.swift | PlanTabWriter, PlanTabActions, PlanEnvironment |
| Plan/QuestionFormView.swift | Plan/QuestionFormModel.swift | QuestionAnswerContext, QuestionFormWriter, QuestionFormModel |
| Plan/VisualBlocksView.swift | Plan/VisualFileTree.swift | VisualFileTree |
| Queues/QueuesStream.swift | Queues/QueuesStream.swift | QueuesPanels, registration |
| Queues/UpNextView.swift | Queues/UpNextState.swift | UpNextSort, UpNextGroup, UpNextPresentation, UpNextNotice, UpNextCommands, UpNextPanelState |
| Queues/HeldQueueView.swift | Queues/HeldQueueState.swift | Held presentation/confirmation/action/commands |
| Queues/QueueActions.swift | Queues/QueueActionState.swift | Queue presentation/confirmation/selection/action/commands, QueueActionState |
| Queues/DonePanelView.swift | Queues/DonePanelState.swift | DoneReads, DonePanelState, DonePresentation, DoneUsageState, DoneRestoreConfirmation |
| Queues/DoneRecapView.swift | Queues/DoneMarkdown.swift | DoneMarkdown |
| Compose/ComposeActions.swift | Compose/ComposeActions.swift | ComposeActions |
| Compose/ComposeFooter.swift | Compose/ComposeReadiness.swift | ComposeReadiness |
| Compose/CapacityLine.swift | Compose/ComposeCapacity.swift | ComposeCapacity |
| Compose/ModelPicker.swift | Compose/ComposeRunConfig.swift | ComposeRunConfig |
| Compose/ModelGuidance.swift | Compose/ModelGuidance.swift | ModelGuidance |
| Compose/ModeTabs.swift | Compose/ComposeMode.swift | ComposeMode |
| Compose/ComposeKeymap.swift | Compose/ComposeKeymap.swift | ComposeKeymap, no environment/view declarations |
| Compose/SourceToggle.swift | Compose/ComposeSource.swift | Source → ComposeSource, identical cases/conformances |
| Merge/MergeOwedView.swift | Merge/MergeOwedState.swift | MergeOwedActions, MergeOwedState |
| Merge/MergePanels.swift | Merge/MergeInputs.swift | MergeInputs |
| Settings/SettingsFields.swift | Settings/SettingsFields.swift | SettingsField, SettingsFields, SettingsFieldDraft |
| Settings/SettingsRepoFields.swift | Settings/SettingsRepoTextDraft.swift | SettingsRepoTextDraft |
| Settings/SettingsAppearance.swift | Settings/SettingsPresentation.swift | SettingsPresentation, same singleton |
| Settings/SettingsAccessView.swift | Settings/SettingsTokenCopy.swift | SettingsTokenCopy |
| Settings/SettingsCommandPalette.swift | Settings/SettingsCommandSearch.swift | SettingsCommandSearch |

Concrete installers in S/Terminal/TerminalTab.swift, Detail/DetailFeature.swift, Sidebar/SidebarView.swift, Actions/ActionsStream.swift, Plan/PlanStream.swift, Queues/QueuesStream.swift, Compose/ComposeStream.swift, Merge/MergeStream.swift and Settings/SettingsFeature.swift become thin direct-install facades plus presentation functions. Neutral statements move to C stream files and run at original statement boundaries. S/LocalServer/LocalServerFeature.swift stays behind the localServer hook.

Additional files:

- C/App/StreamHost.swift; C/Notifications/NotificationEnvironment.swift: explicit contracts below.
- C/App/ResetStreamSeams.swift: moved native/Apps/ShepherdMac/Tests/StreamSeams.swift API, without Testing import.
- C/Resources/Localizable.xcstrings; C/Resources/en.lproj/Localizable.strings; C/Resources/de.lproj/Localizable.strings.
- native/Package.swift; native/Apps/ShepherdMac/project.yml; native/scripts/gen-strings.ts and gen-strings.sh.
- test/contract/native-app-core-boundary.test.ts.
- native/scripts/test-conservation.ts; test/native-test-conservation.test.ts; native/Tests/Conservation/issue-2431-baseline.json and issue-2431-map.json.
- native/Tests/ShepherdAppCoreTests: migrated suites/helpers plus CoreTestSupport.swift, CoreInstallationTests.swift, CurrentSelectionTests.swift, NotificationHostTests.swift and CoreResourceTests.swift.
- native/Apps/ShepherdMac/Tests/MacCoreCompositionTests.swift and MacNotificationEnvironmentTests.swift.
- native/scripts/uitest-lock.sh (portable CI equivalent), select-core-simulator.py and check-core-results.py.
- test/native-core-gates.test.ts; .github/workflows/native.yml; native/docs/development.md.

Retain S/App/ShepherdApp.swift, LaunchEnvironment.swift, LocalServerProbe.swift; all LocalServer files; TerminalHostView.swift/TerminalPane.swift/TerminalTab.swift; folder picker/importer/clipboard/window/menu/settings modifiers; bundle metadata/signing scripts. Regenerate Xcode project through existing scripts; no hand-edited project or view moves.

## Gate protocol and commands

These are future commands, not validation performed while planning. Bash, repository root unless explicitly changed; one foreground command at a time:

~~~bash
set -euo pipefail
UITEST_LOCK=/Users/kai.osthoff/.claude/projects/-Users-kai-osthoff-githubrepos-shepherd/tools/uitest-lock.sh
mkdir -p /private/tmp/claude-501
unset SHEPHERD_KEYCHAIN_TESTS TEST_RUNNER_SHEPHERD_KEYCHAIN_TESTS
EVIDENCE="$PWD/.superpowers/sdd/issue-2431-evidence"
mkdir -p "$EVIDENCE"
gate() {
  local label="$1"
  shift
  local rc=0
  "$@" >"$EVIDENCE/$label.log" 2>&1 || rc=$?
  tail -n 40 "$EVIDENCE/$label.log"
  printf '%s exit=%s\n' "$label" "$rc"
  return "$rc"
}
~~~

Use a unique EVIDENCE directory per tested revision/environment. Logs stay local and are never read whole/committed. No shell tracing or raw secret-bearing logs. Live gates below use only the existing harness's secret-free filtered output; do not tee raw live output. Record tested SHA, environment and result counts, not merely shell exit status.

G1 — generation/root checks; each distinct gate, generation in Task 2:

~~~bash
gate contract-generate bun run gen:contract-swift
gate contract-sync native/scripts/sync-contract.sh
gate strings-generate bun run native/scripts/gen-strings.ts
gate contract-check bun run check:contract-swift
gate sync-check native/scripts/sync-contract.sh --check
gate strings-check bun run check:strings
gate typecheck bun run typecheck
gate lint bun run lint
gate contract-tests bun run test:contract
gate root-tests bun run test
~~~

G2 — local package, no live or Keychain opt-in:

~~~bash
gate package-build swift build --package-path native
gate package-tests swift test --package-path native --no-parallel
~~~

G3 — simulator. Task 2 owns first execution and creates the small selector/result helpers needed here; Task 4 makes them CI-enforced and tests their negative paths:

~~~bash
(
  cd native
  gate core-schemes "$UITEST_LOCK" xcodebuild -list -json
  gate core-simulator-build "$UITEST_LOCK" xcodebuild -scheme ShepherdAppCore \
    -destination 'generic/platform=iOS Simulator' -skipPackagePluginValidation build
)
xcrun simctl list devices available -j >"$EVIDENCE/devices.json"
CORE_SIMULATOR_UDID="$(python3 native/scripts/select-core-simulator.py "$EVIDENCE/devices.json")"
(
  cd native
  gate core-simulator-tests "$UITEST_LOCK" xcodebuild -scheme ShepherdAppCore \
    -destination "platform=iOS Simulator,id=$CORE_SIMULATOR_UDID" \
    -parallel-testing-enabled NO -only-testing:ShepherdAppCoreTests \
    -resultBundlePath "$EVIDENCE/core-simulator.xcresult" \
    -skipPackagePluginValidation test
)
xcrun xcresulttool get test-results summary --path "$EVIDENCE/core-simulator.xcresult" \
  >"$EVIDENCE/core-simulator-summary.json"
python3 native/scripts/check-core-results.py "$EVIDENCE/core-simulator-summary.json"
~~~

Selector contract: read simctl JSON, accept only available devices named iPhone under iOS runtime keys with version ≥18, sort numeric runtime version descending then name/UDID ascending, print chosen UDID only to stdout and runtime/name to stderr; absence is nonzero. Result checker contract: accept the actual installed xcresulttool summary JSON, require totalTestCount > 0, passedTests > 0, failedTests == 0; print passed/failed/skipped/total. Unknown schema fails rather than assuming zero/missing fields mean success. Compare runtime identities and counts to the mapping too; nonzero alone is insufficient.

Confirm scheme includes ShepherdAppCoreTests. If generated package scheme lacks tests, commit native/.swiftpm/xcode/xcshareddata/xcschemes/ShepherdAppCore.xcscheme using discovered target identifiers, no iOS app. Disable test parallelization inside scheme/test plan as well. Preserve --no-parallel for SwiftPM and put all global-seam suites in one @Suite(.serialized) enclosing suite for Xcode; independent suite annotations and process serialization alone do not prevent async interleaving.

G4 — isolated Mac:

~~~bash
gate mac-release "$UITEST_LOCK" native/scripts/build-app.sh Release
gate mac-unit "$UITEST_LOCK" native/scripts/test-app.sh \
  -parallel-testing-enabled NO -only-testing:ShepherdTests \
  -resultBundlePath "$EVIDENCE/mac-unit.xcresult"
gate mac-ui "$UITEST_LOCK" native/scripts/test-app.sh \
  -parallel-testing-enabled NO -only-testing:ShepherdUITests \
  -resultBundlePath "$EVIDENCE/mac-ui.xcresult"
~~~

Preserve CI Release ad-hoc signing, hardened runtime, no release get-task-allow, sandbox false and strict codesign verification. Locally retain existing signing identity/scripts. Missing noninteractive signing prerequisites are UNMET, not permission to prompt.

G5 — required read-only operator live smoke. Environment must already be securely supplied, including the TEST_RUNNER-prefixed base URL/password required for hosted test propagation. Check presence without displaying values; never load settings.local.json:

~~~bash
set -euo pipefail
unset SHEPHERD_KEYCHAIN_TESTS TEST_RUNNER_SHEPHERD_KEYCHAIN_TESTS
if ! printenv TEST_RUNNER_SHEPHERD_LIVE_BASE_URL >/dev/null ||
   ! printenv TEST_RUNNER_SHEPHERD_LIVE_PASSWORD >/dev/null; then
  printf '%s\n' 'UNMET: securely supplied operator live environment absent' >&2
  exit 1
fi
export TEST_RUNNER_SHEPHERD_REVOKE_ON_EXIT=1
"$UITEST_LOCK" native/scripts/test-app.sh -parallel-testing-enabled NO \
  -only-testing:ShepherdTests 2>&1 | tail -n 40
"$UITEST_LOCK" native/scripts/test-app.sh -parallel-testing-enabled NO \
  -only-testing:ShepherdUITests/LiveSmokeUITests 2>&1 | tail -n 40
~~~

Require nonempty values and actual live executions, not just variable presence. Full Mac unit target deliberately includes all per-stream live suites and LiveServerTests; this differs from G4's environment, so is not a redundant ordinary rerun. Verify secret-free request-audit verdict and harness-owned token cleanup. No ad hoc HTTP calls, tokens, status probes or non-isolated launches. Missing environment or skipped live cases leaves G5 UNMET.

G6 — conservation/format:

~~~bash
gate conservation bun run native/scripts/test-conservation.ts --check
gate docs-format ./node_modules/.bin/prettier --check \
  docs/superpowers/specs/2026-09-21-shepherd-app-core-stage-1-design.md \
  docs/superpowers/plans/2026-09-21-shepherd-app-core-stage-1.md \
  native/docs/development.md
~~~

Use installed tools only; missing dependencies/toolchain are explicit prerequisites. Preserve root CI format and other required checks. Every xcodebuild query, including -version, goes through the wrapper; do not nest a lock around an already wrapped invocation.

### Task 1: Capture and enforce the unchanged test baseline

**Tier:** std; review std. Ordinary test-accounting tooling needs identity reasoning beyond mechanical counting.

**Files:** Create native/scripts/test-conservation.ts, test/native-test-conservation.test.ts, native/Tests/Conservation/issue-2431-baseline.json and issue-2431-map.json. Read native/Apps/ShepherdMac/Tests, UITests and native/Tests/ShepherdKitTests only for declaration identity capture. Report in .superpowers/sdd/issue-2431-task-1-report.md.

**Interfaces:**

- Export type TestIdentity = { target: string; path: string; suite: string; signature: string; line: number; attributes: string; condition: string; bodyHash: string }.
- Export type IdentityMap = { oldID: string; destinations: string[]; reason: string; assertionChanges: string[] }. Baseline JSON is { sourceSHA: string, tests: TestIdentity[] }; mapping JSON is { mappings: IdentityMap[], added: string[] }. Source hashes remain immutable; reviewed adjustment explanations live in mappings, not rewritten baseline hashes.
- Export collectTests(root: string): TestIdentity[], identity(test: TestIdentity): string and verifyConservation(baseline: TestIdentity[], current: TestIdentity[], mapping: IdentityMap[], added: string[]): void.
- identity is target + path + fully qualified suite + complete function signature; line is evidence, never stable identity. Parameter attributes/conditional branches are retained separately. Mapping is total over original identities; new tests are explicitly listed, not substitutes. Report both raw final declaration counts and the conserved original-identity count: a one-to-many assertion split counts once toward the 1090 baseline and reports its additional destination declarations explicitly, never as a replacement for an omitted original.
- CLI --capture records immutable baseline plus self-mapping before any relocation; --check compares current source to baseline/map, fails on missing/duplicate destinations, unaccounted additions or changed assertion bodies lacking reviewed explanation. No automatic baseline rewriting during --check.

- [ ] **Step 1: Establish execution ancestry and capture metadata.** After plan approval, verify clean/preserved user work and git ancestry with these read-only checks. If branch creation/rebase is needed, dispatch a fresh light run from origin/main; do not erase the uncommitted approved plan.

~~~bash
git status --short
git rev-parse HEAD
git merge-base HEAD origin/main
git log -1 --format='%h %s' origin/main
~~~

Record baseline source SHA (approved inventory was 83e8d451), platform/tool versions and no-live/no-Keychain environment. If ancestry/source drift changes the stated census, report the exact identity delta; never silently replace 1090/416/13 with a new number.

- [ ] **Step 2: Write negative identity tests before implementing the checker.** Wrap these tests in a describe block named native test conservation. Test fixtures are tiny source strings, not product tests. Cover nested suites, extension-defined suites, multiline @Test(arguments:), two equal function names in different suites, comments/string literals containing @Test and #if branches. Scanner must lex comments/Swift strings and balanced delimiters before finding attributes/functions; never use a line-count-only regex as the conservation oracle. Retain all source conditional branches; do not evaluate host-only conditions during capture.

~~~typescript
test("missing original cannot be replaced by a new test", () => {
  const a: TestIdentity = {
    target: "ShepherdTests", path: "A.swift", suite: "A",
    signature: "old()", line: 1, attributes: "@Test", condition: "", bodyHash: "old",
  };
  const b = { ...a, signature: "new()", bodyHash: "new" };
  expect(() => verifyConservation(
    [a], [b], [{ oldID: identity(a), destinations: [identity(a)],
      reason: "retained", assertionChanges: [] }], [identity(b)]
  )).toThrow();
});
~~~

Add duplicate destination, absent mapping, removed parameter attribute and split-body-loss cases. A one-to-many split keeps one original accounting row but requires every original assertion to be located in a destination. Shared helper moves do not create tests.

- [ ] **Step 3: Run the targeted red test.**

~~~bash
gate conservation-red bun run test --test-name-pattern 'native test conservation'
~~~

Expected: missing exported checker or a failing omission assertion. A tool failure is not the expected red.

- [ ] **Step 4: Implement the scanner/checker and capture actual identities.** Use node:fs/node:path/node:crypto already available under Bun. Tokenize source, associate @Test with its following func at the same declaration depth; track enclosing struct/class/enum/extension names; capture complete attribute/signature/body ranges and #if context. UI entries are XCTest functions starting test in XCTestCase classes. Hash original body text and retain the original source SHA. Use sorted full identities in JSON, not declaration count alone. Reject any ambiguous parse, unmatched brace or duplicate identity; add a focused fixture for a encountered syntax form before accepting it.

Export the checker and scanner behind an import.meta.main CLI guard. The checker’s cardinality logic is:

~~~typescript
const originalIDs = new Set(baseline.map(identity));
if (originalIDs.size !== baseline.length) throw new Error("duplicate baseline identity");
const rows = new Map(mapping.map(row => [row.oldID, row]));
if (rows.size !== mapping.length || rows.size !== originalIDs.size)
  throw new Error("mapping must contain every original exactly once");
for (const oldID of originalIDs) {
  const row = rows.get(oldID);
  if (!row || row.destinations.length === 0) throw new Error("missing original " + oldID);
}
~~~

Then enforce destination existence/uniqueness, exact retained Kit/UI identities, explicit additions, attributes/conditions and reviewed body changes. Mapping body differences must name import/fixture/resource/current-module adjustments; “rewritten equivalent” is not an extraction justification.

~~~bash
gate conservation-green bun run test --test-name-pattern 'native test conservation'
gate baseline-capture bun run native/scripts/test-conservation.ts --capture
gate baseline-check bun run native/scripts/test-conservation.ts --check
~~~

Expected immutable baseline: 98 app support/test files, 1090 @Test declarations; 42 Kit support/test files, 416 declarations; 4 UI support/test files, 13 test methods. The committed JSON contains every real suite/function, not example rows or empty destinations.

- [ ] **Step 5: Record unchanged-base runtime evidence before moves.** Run G2 and G4 unit/UI commands under isolated ordinary environment; run existing G1 checks needed to establish affected generator/contract baseline. Capture .xcresult and Swift Testing summaries; enumerate suites/functions/parameterized cases from result data in bounded filtered output. Record skips (especially live/Keychain) separately. Run G5 baseline if operator environment is available; otherwise record baseline live UNMET and retain final live requirement. Missing baseline execution prevents claiming runtime equivalence; source planning/mapping may proceed, acceptance cannot.

- [ ] **Step 6: Commit and report.**

~~~bash
git add native/scripts/test-conservation.ts test/native-test-conservation.test.ts \
  native/Tests/Conservation/issue-2431-baseline.json \
  native/Tests/Conservation/issue-2431-map.json
git commit -m "test(native): record Stage 1 test conservation baseline"
~~~

Report actual counts/identities and gate evidence; fresh std review must accept conservation before Task 2. Do not add .superpowers files.

### Task 2: Extract the complete graph with working Mac composition

**Tier:** deep; review deep. Lifecycle/concurrency/public API/resource integration is one coherent buildable change.

**Files:** All move/split/addition paths in the file map; native/Tests/Conservation/issue-2431-map.json; native/Apps/ShepherdMac/Tests and native/Tests/ShepherdAppCoreTests according to the destination rules below; native/scripts/select-core-simulator.py and check-core-results.py. Do not alter Kit implementations or generated server contracts.

**Interfaces — retain and export:**

- @MainActor public protocol AppExtension: AnyObject with init(store: SessionStore, app: AppModel) and func teardown().
- AppModel.register<E: AppExtension>(_ type: E.Type); typed method named extension<E: AppExtension>(_ type: E.Type) -> E? (keep Swift keyword escaping in source).
- Public AppModel initializer becomes init(defaults: UserDefaults = .standard, credentials: any CredentialStore = KeychainCredentialStore(), notifications: NotificationEnvironment). Required final argument prevents an implicit system default; existing test call sites must supply a fake environment. Store configuration as @ObservationIgnored public let notificationEnvironment: NotificationEnvironment. Production still uses the same credential/default behavior.
- @MainActor public enum StreamRegistrations: configure(_ host: StreamHost), installScene(), installAll(into app: AppModel), reset(); public nested final class Installation retains init(scene: @escaping @MainActor () -> Void, model: @escaping @MainActor (AppModel) -> Void), installScene(), installAll(into:), reset().
- @MainActor public func resetStreamSeams(); reset only existing mutable seams/scene guard, not host configuration.
- Public DetailTab retains Identifiable/Sendable with ID == String, id/title/systemImage/order and @MainActor makeView(session: Session, store: SessionStore, app: AppModel) -> AnyView.
- Public L retains t(_ key: StaticString) -> String and t(_ key: StaticString, _ args: any CVarArg...) -> String.
- NotificationCenterClient retains exact protocol methods, including start(), onSelectSession: ((String) -> Void)?, authorization() async, requestAuthorization() async, post(_:) async -> Bool, setBadgeCount(_:) async -> Bool and clearBadgeNow(). Public witnesses on public fake/system types; no replacement with UserNotifications types.

**New notification contract (C/Notifications/NotificationEnvironment.swift):**

~~~swift
import Foundation

@MainActor
public protocol NotificationFocusSource: AnyObject {
    func sample() -> Bool
    func observe(_ receive: @escaping @MainActor (Bool) -> Void)
        -> @MainActor () -> Void
}

@MainActor
public struct NotificationEnvironment {
    public let makeCenter: @MainActor () -> any NotificationCenterClient
    public let makeDefaults: @MainActor () -> UserDefaults
    public let focus: any NotificationFocusSource

    public init(
        makeCenter: @escaping @MainActor () -> any NotificationCenterClient,
        makeDefaults: @escaping @MainActor () -> UserDefaults,
        focus: any NotificationFocusSource
    ) {
        self.makeCenter = makeCenter
        self.makeDefaults = makeDefaults
        self.focus = focus
    }
}
~~~

observe synchronously installs observers and returns synchronous idempotent removal; it does not emit an initial event. sample is synchronous. Adapter delivers on the main actor, without creating/cancelling another task. Core owns the existing tracked focusTask scheduling, including not cancelling the prior rapid transition.

**New host contract (C/App/StreamHost.swift):**

~~~swift
import SwiftUI
import ShepherdKit

@MainActor
public struct StreamHost {
    public typealias SceneHook = @MainActor () -> Void
    public typealias ModelHook = @MainActor (AppModel) -> Void
    public typealias PromptRenderer =
        @MainActor (Session, SessionStore, AppModel) -> AnyView

    public let prompt: PromptRenderer
    public let queuesPanels: SceneHook
    public let mergeScene: SceneHook
    public let wave2Panels: SceneHook
    public let settingsScene: SceneHook
    public let terminalTab: ModelHook
    public let detailTabs: ModelHook
    public let sidebarSlot: ModelHook
    public let actionBarSlot: ModelHook
    public let localServer: ModelHook
    public let planTab: ModelHook
    public let compose: ModelHook
    public let mergePresentation: ModelHook
}
~~~

Add this initializer inside StreamHost, with no defaults, priorities or dynamically registered installers:

~~~swift
public init(
    prompt: @escaping PromptRenderer,
    queuesPanels: @escaping SceneHook,
    mergeScene: @escaping SceneHook,
    wave2Panels: @escaping SceneHook,
    settingsScene: @escaping SceneHook,
    terminalTab: @escaping ModelHook,
    detailTabs: @escaping ModelHook,
    sidebarSlot: @escaping ModelHook,
    actionBarSlot: @escaping ModelHook,
    localServer: @escaping ModelHook,
    planTab: @escaping ModelHook,
    compose: @escaping ModelHook,
    mergePresentation: @escaping ModelHook
) {
    self.prompt = prompt
    self.queuesPanels = queuesPanels
    self.mergeScene = mergeScene
    self.wave2Panels = wave2Panels
    self.settingsScene = settingsScene
    self.terminalTab = terminalTab
    self.detailTabs = detailTabs
    self.sidebarSlot = sidebarSlot
    self.actionBarSlot = actionBarSlot
    self.localServer = localServer
    self.planTab = planTab
    self.compose = compose
    self.mergePresentation = mergePresentation
}
~~~

 Configure once before any production scene installation; a second production configure is a precondition failure. Tests use one deterministic host per process, no per-test replacement; independent Installation instances remain available for lifecycle probes. Store host as private static optional; internal requiredHost getter preconditions when needed. Registry metadata reads need no host. Prompt rendering fails with “Configure StreamRegistrations before rendering the prompt” when host is missing.

C/App/StreamRegistrations.swift declares public @MainActor enum CoreStreamInstallers; implement its public static methods in extensions in the corresponding C stream files. Its exact methods are installTerminal(into: AppModel), installDetail(into:), installSidebar(into:), installActions(into:), installPlan(into:), installQueues(into:), installMerge(into:), installSettings(into:), all returning Void. These are fixed compositions used by full install and the existing Mac direct-installer facades. Do not retain a second model-registration implementation in the facades.

- [ ] **Step 1: Write boundary/red contract tests.** Create test/contract/native-app-core-boundary.test.ts with a describe block named native app core boundary. Require package product/target/test target, reject core import of AppKit/UIKit/SwiftTerm/Shepherd including attributes, conditional blocks and scoped imports, reject core declarations conforming to View/ViewModifier/App/Scene, and require absence of old moved definitions. Strip comments/strings lexically before matching imports; test scanner fixtures for conditional import and “import class AppKit.NSApplication”. Preserve existing native-open-enum.test.ts coverage across native/Sources and native/Apps.

~~~typescript
test("rejects scoped and conditional platform imports", () => {
  expect(forbiddenImports("#if os(macOS)\nimport class AppKit.NSApplication\n#endif"))
    .toEqual(["AppKit"]);
  expect(forbiddenImports("// import AppKit\nimport SwiftUI")).toEqual([]);
});
~~~

Export forbiddenImports(source: string): string[] from the test helper in that file; source guard scans only C production .swift files. The simulator remains the semantic gate for transitive Mac-only symbols.

~~~bash
gate boundary-red bun run test:contract --test-name-pattern 'native app core boundary'
~~~

Expected missing core target/source boundary. Do not count unrelated baseline failure as red. Put every new boundary test under the named describe block so the command selects it; assert a nonzero matched-test count.

- [ ] **Step 2: Add the graph-wide failing tests before moves.** Write the new core tests using the signatures here. They initially fail because ShepherdAppCore is absent. Add MacCoreCompositionTests and MacNotificationEnvironmentTests to the Mac target. Existing AppExtensionTests and StreamRegistrationsTests are regression oracles; do not reproduce their implementations in the plan.

CurrentSelectionTests pins the shared predicate using existing DEBUG PreviewData session fixtures and an in-memory SessionStore:

~~~swift
@Test @MainActor
func rejectsDifferentStoreAndSelection() async throws {
    let app = CoreTestSupport.makeApp()
    defer { CoreTestSupport.cleanup(app) }
    let profile = try app.addRemoteProfile(name: "fixture", address: "https://fixture.invalid")
    await app.activate(profile)
    let first = try #require(app.store)
    let second = try SessionStore(profile: profile, credentials: InMemoryCredentialStore())
    let session = PreviewData.session()
    app.selectedSessionID = session.id
    #expect(CurrentSessionSelection.isCurrent(session: session, store: first, app: app))
    #expect(!CurrentSessionSelection.isCurrent(session: session, store: second, app: app))
    app.selectedSessionID = nil
    #expect(!CurrentSessionSelection.isCurrent(session: session, store: first, app: app))
}
~~~

This uses the existing PreviewData.session() constructor and activate(_:) path; store remains private(set). Preserve original AppExtensionTests activation fixtures and credential probes. No test-only writable store property is introduced.

- [ ] **Step 3: Move whole files and split mixed declarations exactly as the map specifies.** For each whole-file row execute the same two actions:

~~~bash
mkdir -p native/Sources/ShepherdAppCore/App
git mv native/Apps/ShepherdMac/Sources/App/AppModel.swift \
  native/Sources/ShepherdAppCore/App/AppModel.swift
~~~

Repeat with the literal directory/filenames in the whole-file table; use declaration cuts, not copies, for the split table. Preserve original bodies and source history. Move the catalog with git mv, remove old Mac catalog membership, and move StreamSeams.swift into C/App/ResetStreamSeams.swift after removing Testing/Shepherd imports. Add public only at actual app consumption/protocol boundaries, including explicit constructors for previously synthesized internal initializers; preserve nested enums/private(set)/test injection points. No underscored re-export or blanket public conversion.

Add product and targets to native/Package.swift, keeping existing Kit target/dependencies untouched:

~~~swift
// Package arguments:
defaultLocalization: "en",

// products entry:
.library(name: "ShepherdAppCore", targets: ["ShepherdAppCore"]),

// targets entries:
.target(
    name: "ShepherdAppCore",
    dependencies: ["ShepherdKit"],
    resources: [
        .copy("Resources/Localizable.xcstrings"),
        .process("Resources/en.lproj"),
        .process("Resources/de.lproj")
    ],
    swiftSettings: [.enableUpcomingFeature("ExistentialAny")]
),
.testTarget(
    name: "ShepherdAppCoreTests",
    dependencies: ["ShepherdAppCore"],
    swiftSettings: [.enableUpcomingFeature("ExistentialAny")]
),
~~~

Swift 6 language mode remains package-wide; no suppression flags. Add package ShepherdKit/product ShepherdAppCore to both Shepherd and ShepherdTests dependencies in project.yml. Add import ShepherdAppCore to consuming Mac sources; mixed tests use @testable import ShepherdAppCore and @testable import Shepherd. Core cannot import Shepherd.

- [ ] **Step 4: Break the two reverse view dependencies without algorithm changes.**

~~~swift
@MainActor
public enum CurrentSessionSelection {
    public static func isCurrent(session: Session, store: SessionStore, app: AppModel) -> Bool {
        app.store === store && app.selectedSessionID == session.id
    }
}
~~~

Replace QuestionFormWriter.live's ActionBarView.isCurrent call with CurrentSessionSelection.isCurrent. Retain ActionBarView.isCurrent as a one-line forwarding wrapper for existing callers/tests. Preserve PlanDetailTab.currentSelection's activation generation check around that predicate. Lift SourceToggle.Source to ComposeSource; inside retained SourceToggle use typealias Source = ComposeSource. Change ComposeModel to name ComposeSource directly. Do not change enum cases, conformances or persisted representations.

- [ ] **Step 5: Wire prompt and fixed ordered host composition.** PromptDetailTab.makeView calls requiredHost.prompt(session, store, app). MacStreamHost.configure() supplies the unchanged AnyView(PromptTabView(session: session)) renderer and all 12 remaining hooks explicitly. It has a Mac-owned configure-once guard for app initialization, preview helpers and direct-installer tests; no host callback captures an AppModel/SessionStore. Calls use their passed model. Core configuration survives reset.

Extract neutral statements into CoreStreamInstallers and invoke host hooks at these exact positions:

| Composition | Statement sequence |
| --- | --- |
| Scene | queuesPanels → mergeScene → wave2Panels → settingsScene |
| Terminal | terminalTab(app) → app.register(TerminalController.self) |
| Detail | app.register(DetailModel.self) → detailTabs(app) |
| Sidebar | app.register(SidebarModel.self) → sidebarSlot(app) |
| Actions | app.register(ActionsModel.self) → actionBarSlot(app) |
| LocalServer | localServer(app), unchanged Mac installer |
| Notifications | NotificationsStream.install(app), reading injected environment |
| Shared seams | SessionSignals.connect(app) |
| Plan | app.register(PlanModel.self) → planTab(app) → original question/reviewing signal assignments |
| Herd | unchanged HerdStream.install(app), HerdSignals then HerdBindings |
| Queues | queuesPanels() → app.register(QueuesModel.self) |
| Compose | compose(app), unchanged presentation composition |
| Merge | app.register(MergeModel.self) → mergePresentation(app), including tab then existing weak slot wrapping |
| Wave2 | wave2Panels() → unchanged neutral Wave2Seams.connect assignments |
| Settings | app.register(SettingsModel.self) → app.register(SettingsReadyModel.self) |
| Bridges | original SettingsNotificationBridge git/reviewing/sendReady closures |

Production Installation uses this fixed model order, not a generic configurable order. Keep independent Installation(scene:model:) unchanged. In direct Mac facades (TerminalInstall.install(into:), DetailFeature.install, SidebarInstall.run, ActionsStream.install, PlanStream.install, QueuesStream.install, MergeStream.install, SettingsFeature.install), ensure Mac host configuration then call the one corresponding CoreStreamInstallers method. Hook functions contain only the extracted rendering statements, never call those facades recursively. Queues scene/panel and Wave2 panel methods remain reusable Mac presentation functions. ComposeStream.resetActionsForTesting stays Mac-only.

In ShepherdApp.init(), call MacStreamHost.configure() before installScene() or Scene reads. Normal AppModel construction supplies MacNotificationEnvironment.make(configuration: launch); IsolatedLaunch.makeModel() supplies its own already-stored launch configuration. Update previews and direct installer tests explicitly. Preserve normal/isolated launch sequencing and the isolated live disables-writes setup.

- [ ] **Step 6: Inject notifications without changing callback scheduling.** Implement MacNotificationEnvironment.make(configuration: LaunchEnvironment.Configuration) -> NotificationEnvironment and MacNotificationFocusSource: NotificationFocusSource in the retained Mac adapter file. sample returns NSApp?.isActive ?? false. observe moves the original NotificationCenter registrations/raw notification names/MainActor.assumeIsolated bridge, and returns synchronous token removal. Use the same .standard versus unique isolated defaults suite fallback and FakeNotificationCenter versus SystemNotificationCenter choice as before.

In core NotificationsModel.init(store:app:), replace only center/default construction and focus observation/sample:

~~~swift
let environment = app.notificationEnvironment
self.center = environment.makeCenter()
let settingsStore = NotificationSettingsStore(defaults: environment.makeDefaults())
// Retain profile/clock/trigger/store/policy initialization in its current order.
// After click handler, center.start() and subscribe(to: store):
cancelFocusObservation = environment.focus.observe { [weak self] focused in
    guard let self else { return }
    self.focusTask = Task { [weak self] in
        guard !Task.isCancelled else { return }
        await self?.setWindowFocused(focused)
    }
}
windowFocused = environment.focus.sample()
~~~

Declare @ObservationIgnored private var cancelFocusObservation: (@MainActor () -> Void)?; remove core NSObject observer storage/names/AppKit imports. Keep the authorization launchTask and its captured activationGeneration exactly after the sample. Teardown cancels owned tasks, calls cancelFocusObservation?() and nils it synchronously, clears click callback/store/badge source, then calls clearBadgeNow(). Do not cancel the previous rapid focus task, insert an await before sample, replay stale initial focus or promise OS FIFO.

NotificationHostTests uses a main-actor recording focus source and delayed center conformer. Reuse continuation patterns from NotificationsBadgeRaceTests; no sleeps. Required new test sequence:

~~~swift
// Within focusTransitionsDuringAuthorizationAndTeardown:
focus.value = true
let model = NotificationsModel(store: store, app: app)
#expect(model.windowFocused) // before any suspension
#expect(trace.prefix(3) == ["start", "observe", "sample"])
await center.waitUntilAuthorizationRequested()
focus.send(false)
focus.send(true)
await model.waitForFocusTaskForTesting()
#expect(model.windowFocused)
focus.send(false)
await model.waitForFocusTaskForTesting()
center.resumeAuthorization(.granted)
await model.waitForLaunchTaskForTesting()
#expect(!model.windowFocused) // the initial true sample must not be replayed
#expect(focus.delivered == [false, true, false])
model.teardown()
#expect(focus.observerCount == 0)
#expect(center.onSelectSession == nil)
#expect(trace.suffix(2) == ["cancel-observation", "clear-now"])
~~~

Test-local RecordingFocus implements sample/observe/send(_:), observerCount, value and delivered: [Bool]; its cancellation logs cancel-observation and clears its receiver synchronously. RecordingCenter implements the unchanged client, logs start/clear-now and parks **only the first** authorization call with a continuation. Later authorization reads return .granted immediately. waitUntilAuthorizationRequested() async waits for the first call; resumeAuthorization(_ value: NotificationAuthorization) resumes it. Add internal, main-actor task-drain test seams to NotificationsModel without changing task ownership or access:

~~~swift
func waitForFocusTaskForTesting() async { await focusTask?.value }
func waitForLaunchTaskForTesting() async { await launchTask?.value }
~~~

The test sets app.activeProfile through the existing addRemoteProfile/activate fixture path, constructs a SessionStore with in-memory credentials, and injects the same RecordingFocus/RecordingCenter through NotificationEnvironment. No global Mac notifications are used in core. Record starts/observe/sample before the first await, synchronously drain the latest focus task before releasing the delayed launch authorization, and verify no stale initial focus replay. The rapid false/true pair is delivered before either drain; preserve the source's deliberate absence of prior-task cancellation. Reuse NotificationsModelTests.theTeardownClearCannotLandOnTheNextProfilesCount and all four NotificationsBadgeRaceTests unchanged after import migration. No sleep or arbitrary yield budget is needed for the new test.

- [ ] **Step 7: Finish package localization in the same buildable extraction.** Move L with its StaticString overloads; only change lookup:

~~~swift
public static func t(_ key: StaticString) -> String {
    String(localized: String.LocalizationValue(stringLiteral: "\(key)"), bundle: .module)
}
~~~

Retain .current String(format:locale:arguments:). Add internal enum CoreResources with static var bundle: Bundle { .module } for @testable resource access only. StringCatalogTests/PlaceholderRenderingTests read CoreResources.bundle.url(forResource: "Localizable", withExtension: "xcstrings"), no #filePath.

Change gen-strings.ts's OUT base to native/Sources/ShepherdAppCore/Resources. Refactor build() to return its already-converted catalog object; render JSON and EN/DE .strings from that object, not separate convert calls. Export stringsLiteral(value: string): string and renderStrings(entries: Record<string, string>): string. Escape backslash, quote, newline, CR, tab and other U+0000–001F controls; use \Uhhhh for remaining controls. Sort keys; output one quoted key = quoted value; line per entry plus final newline. Keep placeholderOrder/convert, manifest checks/comments and EN-first numbering unchanged. CLI computes all three expected texts first, mkdirSync parent directories recursively, writes all three; --check reads all three, accumulates missing/stale paths and exits nonzero if any differ. Do not process xcstrings into duplicate runtime output.

Basic red/green generator test in this task requires three outputs and failure for a missing DE .strings file; Task 3 adds adversarial fixtures. Run the CLI tests in a temporary directory using exported output builder/check helper, never corrupt committed resources to simulate staleness.

- [ ] **Step 8: Migrate tests by actual identity, not filename count.** Start from Task 1's mapping. Whole shared files use git mv into native/Tests/ShepherdAppCoreTests with the same filename. Split mixed suites into original Mac filename plus core filename suffixed CoreTests.swift, preserving each original method/assertion and mapping both if a scenario truly splits.

Default core candidates by exact existing filename: AppModelTests.swift, AppExtensionTests.swift, ProfileStoreTests.swift, ConnectionBannerTests.swift, FirstRunSubmissionTests.swift, LoginSheetStateTests.swift, NewSessionSubmissionTests.swift, NoticeToneTests.swift, SessionCommandStateTests.swift, SessionSignalsTests.swift, SessionStatusStyleTests.swift, ShepherdErrorCopyTests.swift, SidebarModelTests.swift, HerdPartitionTests.swift, HerdClassifierTests.swift, HerdSignalsTests.swift, HerdStepperTests.swift, DetailModelTests.swift, UnifiedPatchTests.swift, ActionRulesTests.swift, ActionsModelTests.swift, PlanModelTests.swift, PlanGateChipTests.swift, QuestionFormTests.swift, QueuesModelTests.swift, UpNextTests.swift, HeldQueueTests.swift, DonePanelTests.swift, ComposeModelTests.swift, ComposeShapeTests.swift, ComposeKeymapTests.swift, ModelGuidanceTests.swift, IssuePickerTests.swift, MergeModelTests.swift, MergeRulesTests.swift, MergeQueueTests.swift, MergeOwedTests.swift, SettingsModelTests.swift, SettingsTokensTests.swift, SettingsReadyTests.swift, SettingsFieldsTests.swift, SettingsRepoTests.swift, SettingsDiagnosticsTests.swift, SettingsTestServerTests.swift, SettingsNotificationDeliveryTests.swift, TerminalStateTests.swift, UsageMeterTests.swift, NotificationCopyTests.swift, NotificationTriggerTests.swift, NotificationSettingsTests.swift, NotificationsBadgeRaceTests.swift, StringCatalogTests.swift, PlaceholderRenderingTests.swift. For any candidate's retained-view assertion, split it instead of deleting or guarding the whole suite.

Explicit mixed classification: StreamRegistrationsTests.swift, SettingsIntegrationTests.swift, SettingsFinalTests.swift, SettingsRegistrationTests.swift, SettingsSceneTests.swift, DetailFeatureTests.swift, SidebarInstallTests.swift, MergeRegistrationTests.swift, FolderPickerTests.swift; plus ActionBarTests.swift, DetailTabRegistryTests.swift, CommandRegistryTests.swift, NewSessionSlotTests.swift, SlotTests.swift, NotificationsModelTests.swift, NotificationCenterClientTests.swift, GitPanelTests.swift, HerdBadgesTests.swift, SessionBadgesTests.swift, SidebarViewTests.swift, VisualBlocksTests.swift and every per-stream *StringsTests.swift. Pure rules/catalog/lookup/fake client cases go core; actual Mac view/adapter/composition cases stay Mac.

Keep LaunchEnvironmentTests.swift, LocalServerModelTests.swift, LocalServerPanelTests.swift, LocalServerProbeTests.swift and all actual live suites Mac-owned. Pure unit cases inside live-named files are still mapped by dependency and move if shared. Every one of the 98 source/support files is classified by the mapping, including helpers; any file not covered by the above categories must be explicitly classified before the task can pass. Kit's 416 declarations and all 13 UI methods remain unchanged.

Move shared latches/fake readers with consumers; if helper is needed by both targets, expose internal core test seam or keep small fixture construction in each test support file, not duplicate production algorithms. Tests/previews construct AppModel with throwaway UserDefaults, InMemoryCredentialStore and explicit fake NotificationEnvironment. CoreTestSupport.makeApp() -> AppModel creates a unique suite and uses a deterministic FakeFocusSource plus FakeNotificationCenter; CoreTestSupport.cleanup(_ app: AppModel) calls app.teardown() and removes that suite. Keep a test-only main-actor map from ObjectIdentifier(app) to suite name; each test defers cleanup. Fake environment factories return the test center/defaults/focus, never persistent defaults or an implicit Keychain default.

Concrete support implementation (Foundation/Testing/SwiftUI/ShepherdKit plus @testable ShepherdAppCore imports). Core registry tests call configureHost() once; Mac tests configure the real Mac host, never both in one process.

~~~swift
@MainActor
final class FakeFocusSource: NotificationFocusSource {
    func sample() -> Bool { false }
    func observe(_ receive: @escaping @MainActor (Bool) -> Void)
        -> @MainActor () -> Void { {} }
}

@MainActor
enum CoreTestSupport {
    private static var suites: [ObjectIdentifier: String] = [:]
    private static var configured = false
    static var promptCalls = 0

    static func configureHost() {
        guard !configured else { return }
        configured = true
        StreamRegistrations.configure(StreamHost(
            prompt: { _, _, _ in
                promptCalls += 1
                return AnyView(Text("fixture"))
            },
            queuesPanels: {}, mergeScene: {}, wave2Panels: {}, settingsScene: {},
            terminalTab: { _ in }, detailTabs: { _ in },
            sidebarSlot: { _ in }, actionBarSlot: { _ in },
            localServer: { _ in }, planTab: { _ in },
            compose: { _ in }, mergePresentation: { _ in }))
    }

    static func makeApp() -> AppModel {
        let name = "run.shepherd.core.tests." + UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(),
            notifications: NotificationEnvironment(
                makeCenter: { FakeNotificationCenter() },
                makeDefaults: { defaults }, focus: FakeFocusSource()))
        suites[ObjectIdentifier(app)] = name
        return app
    }

    static func cleanup(_ app: AppModel) {
        app.teardown()
        if let name = suites.removeValue(forKey: ObjectIdentifier(app)) {
            UserDefaults(suiteName: name)?.removePersistentDomain(forName: name)
        }
    }
}
~~~

The empty fixture hooks exist only in tests. Core registration tests assert models/signals; actual tabs/slots/composition tests stay Mac with real hooks. Production has no empty defaults. CoreInstallationTests.resetKeepsPromptHost checks the promptCalls delta around rendering before/after reset.


Wrap registry-mutating suites in one serialized enclosing CoreSeamTests (and one MacSeamTests for retained hosted global tests), retaining existing nested .serialized attributes. Record resulting fully qualified identity changes. No shared async reset can interleave with another suspended global-seam test.

- [ ] **Step 9: Pin reset/composition behavior with real Mac hooks.** CoreInstallationTests.resetKeepsPromptHost registers an override descriptor, resets, requires tabs IDs == ["prompt"], renders the restored descriptor with a fixture factory and verifies the same configured host renderer ran. A test renderer may use AnyView(Text("fixture")) in the test bundle; production core cannot declare a View or substitute EmptyView.

MacCoreCompositionTests.resetThenRepeatedProductionPasses calls MacStreamHost.configure(), resetStreamSeams(), installScene(), then installAll(into:) twice using scratch in-memory models. Render prompt, terminal/detail/plan tabs and queues owed panel through real Mac factories. Assert actual prompt accessibility identifier/body, scene commands/settings panes before model installation, integrated owed panel after each pass, predecessor action/sidebar content present once, conservative MergeInputs defaults after reset, and weak composition owner release on slot reset. Use existing productionPassesInstallAndResetEveryRegistry assertions and wave-1/2 integration tests as the starting scenario, preserving all of them. Add weak probe references at existing test seams rather than new public owner access.

MacNotificationEnvironmentTests supplies isolated configuration and asserts fake center/no system permission path, profile-scoped settings and observer removal. Existing isolatedLiveLaunchDisablesWritesBeforeInstallingStreams must still assert both queue and terminal prohibitions. Retain stale activation/bootstrap conservatism/bridge-resolution/repeated-install tests.

- [ ] **Step 10: Run targeted green, then the first coherent full gates.**

~~~bash
gate core-focused swift test --package-path native --no-parallel \
  --filter 'CoreSeamTests|CurrentSelectionTests|NotificationHostTests|AppExtensionTests|NotificationsBadgeRaceTests'
gate mac-composition "$UITEST_LOCK" native/scripts/test-app.sh \
  -parallel-testing-enabled NO -only-testing:ShepherdTests/MacCoreCompositionTests
gate boundary-green bun run test:contract --test-name-pattern 'native app core boundary'
gate generator-green bun run test --test-name-pattern 'gen-strings'
gate conservation bun run native/scripts/test-conservation.ts --check
~~~

If nesting changes Xcode selectors, use the exact compiled identifier from discovery/result evidence; a zero-match selector fails. Run G1, G2, G3, G4 after all graph changes. Report actual moved core declaration count and run each on both platforms; retain every Mac-only case on Mac. Compare assertions/parameterization/skips to baseline. Verify no contract/schema semantic diff, appVersion/persistence identity unchanged, no duplicated moved definitions, no unsafe annotation additions. A simulator incompatibility in existing Kit is reported explicitly, never patched through a platform stub.

- [ ] **Step 11: Commit only after coherent validation and report.**

~~~bash
git add native/Package.swift native/Sources/ShepherdAppCore \
  native/Tests/ShepherdAppCoreTests native/Tests/Conservation/issue-2431-map.json \
  native/Apps/ShepherdMac/Sources native/Apps/ShepherdMac/Tests \
  native/Apps/ShepherdMac/Resources native/Apps/ShepherdMac/project.yml \
  native/scripts/gen-strings.ts native/scripts/gen-strings.sh \
  native/scripts/select-core-simulator.py native/scripts/check-core-results.py \
  test/native-gen-strings.test.ts test/contract/native-app-core-boundary.test.ts
git commit -m "refactor(native): extract the shared application core"
~~~

Include the optional verified shared scheme only if needed. Stage deletions as well as additions; inspect staged diff, especially no Kit/contract semantic changes or secrets. Report APIs, ordering, original→destination census, raw/runtime count distinction, gates and unmet prerequisites. Fresh deep review before Task 3.

### Task 3: Prove runtime localization and escaping on both platforms

**Tier:** mid; review std. Tests-only hardening of Task 2's working generator/resources; if a product defect is found, use a fresh scoped fix at mid for localization or deep for architecture, then fresh review.

**Files:** Modify test/native-gen-strings.test.ts; native/Tests/ShepherdAppCoreTests/CoreResourceTests.swift, StringCatalogTests.swift and PlaceholderRenderingTests.swift; native/Apps/ShepherdMac/Tests/MacCoreCompositionTests.swift; record additions in native/Tests/Conservation/issue-2431-map.json.

**Interfaces:** Consume stringsLiteral(value: string): string, renderStrings(entries: Record<string, string>): string, placeholderOrder(en: string): Map<string, number>, convert(value: string, order: Map<string, number>): string and internal CoreResources.bundle. No new public localization API.

- [ ] **Step 1: Add exact escaping/reordering and freshness tests.** Put added cases inside a describe block named gen-strings core resources, retaining existing gen-strings suites.

~~~typescript
test("strings source escapes syntax and controls", () => {
  expect(stringsLiteral('a"b\\c\n\r\t\u0001'))
    .toBe('"a\\"b\\\\c\\n\\r\\t\\U0001"');
});
test("German reorders the English argument positions once", () => {
  const order = placeholderOrder("{first} paid {second}, 50%");
  expect(convert("{second} von {first}, 50%", order))
    .toBe("%2$@ von %1$@, 50%%");
  expect(convert("50% off", placeholderOrder("50% off"))).toBe("50% off");
});
~~~

Test empty/fresh output directory creation, sorted deterministic entries, escaped keys as well as values, catalog comments unchanged, duplicate manifest rejection, unknown DE placeholders and independent missing/stale catalog/en/de failure. Use temporary fixture output directories and restore/remove them with finally; never overwrite real translations during tests. Preserve all current generator tests.

- [ ] **Step 2: Add complete bundle resolution coverage and actual Mac consumption.**

~~~swift
@Test
func everyCatalogEntryResolvesInBothLocales() throws {
    let catalogURL = try #require(CoreResources.bundle.url(
        forResource: "Localizable", withExtension: "xcstrings"))
    let root = try #require(
        JSONSerialization.jsonObject(with: Data(contentsOf: catalogURL)) as? [String: Any])
    let entries = try #require(root["strings"] as? [String: [String: Any]])
    #expect(!entries.isEmpty)
    for language in ["en", "de"] {
        let directory = try #require(CoreResources.bundle.url(
            forResource: language, withExtension: "lproj"))
        let localized = try #require(Bundle(url: directory))
        for (key, entry) in entries {
            let locales = try #require(entry["localizations"] as? [String: [String: Any]])
            let unit = try #require(locales[language]?["stringUnit"] as? [String: String])
            let expected = try #require(unit["value"])
            #expect(localized.localizedString(forKey: key, value: "__MISSING__", table: nil)
                == expected, Comment(rawValue: "\(language): \(key)"))
        }
    }
}
~~~

Use Foundation/Testing and @testable import ShepherdAppCore. Preserve PlaceholderRenderingTests' full-key EN/DE argument-formatting assertions; extend to formats read from runtime language bundles, not only xcstrings source. Test L.t("native_welcome_local_title") matches the module's selected localization and L.t's argument overload matches .current formatting. Mac host test renders retained welcome/prompt view and asserts actual translated text/accessibility with core L, not merely non-key output; preserve EN/DE expectations for separately selected language test launches.

- [ ] **Step 3: Demonstrate meaningful red and restore green.** With tests staged but no production change, temporarily mutate only a backed-up generator escaping branch to omit quote escaping; run the targeted generator test and record its expected assertion failure. Restore that exact hunk, rerun green. For bundle coverage, a temporary test fixture missing de.lproj must be rejected by the same resource-verification helper; never mask missing real resources with fallback English. Do not commit fault mutations or change unrelated user edits.

~~~bash
gate generator-localization bun run test --test-name-pattern 'gen-strings'
gate core-resources swift test --package-path native --no-parallel \
  --filter 'CoreResourceTests|StringCatalogTests|PlaceholderRenderingTests'
~~~

Run these focused simulator commands with the selected G3 device and a fresh result path:

~~~bash
(
  cd native
  gate simulator-resources "$UITEST_LOCK" xcodebuild -scheme ShepherdAppCore \
    -destination "platform=iOS Simulator,id=$CORE_SIMULATOR_UDID" \
    -parallel-testing-enabled NO \
    -only-testing:ShepherdAppCoreTests/CoreResourceTests \
    -only-testing:ShepherdAppCoreTests/StringCatalogTests \
    -only-testing:ShepherdAppCoreTests/PlaceholderRenderingTests \
    -resultBundlePath "$EVIDENCE/core-resource-tests.xcresult" \
    -skipPackagePluginValidation test
)
xcrun xcresulttool get test-results summary --path "$EVIDENCE/core-resource-tests.xcresult" \
  >"$EVIDENCE/core-resource-summary.json"
python3 native/scripts/check-core-results.py "$EVIDENCE/core-resource-summary.json"
~~~

Use compiled qualified identifiers if nested and require all selected scenarios in the result identity list. Run focused MacCoreCompositionTests with the wrapped G4 command. All new test identities must execute, so Task 2's full results alone are not sufficient for these added tests. Do not repeat unaffected full gates.

- [ ] **Step 4: Commit/report with original versus added counts.**

~~~bash
git add test/native-gen-strings.test.ts native/Tests/ShepherdAppCoreTests \
  native/Apps/ShepherdMac/Tests/MacCoreCompositionTests.swift \
  native/Tests/Conservation/issue-2431-map.json
git commit -m "test(native): verify core localization bundles and escaping"
~~~

Report the injected-fault red, restored green, macOS/simulator executed counts and Mac copy evidence. Fresh std review reuses results.

### Task 4: Enforce simulator and isolated CI coverage; close live gates

**Tier:** deep; review deep. Semantic platform validation and CI environment isolation are integration work.

**Files:** Modify .github/workflows/native.yml; native/scripts/select-core-simulator.py, check-core-results.py; create native/scripts/uitest-lock.sh and test/native-core-gates.test.ts. Optional shared scheme at native/.swiftpm/xcode/xcshareddata/xcschemes/ShepherdAppCore.xcscheme only if Task 2 discovery required it. Existing .github/workflows/ci.yml and macos.yml policy stays unchanged.

**Interfaces:** Portable wrapper accepts command argv unchanged and exits with child status; no operator-home path in CI. Selector stdout is exactly one available iPhone UDID (iOS≥18); diagnostic runtime/name goes stderr. Result checker fails unknown schema, zero execution or failed tests. CI core step environment contains neither Keychain opt-in spelling and no live variables.

- [ ] **Step 1: Write gate-fixture tests before changing CI.** Wrap cases in a describe block named native core gates. test/native-core-gates.test.ts executes Python helpers with temporary JSON files using Bun.spawnSync argument arrays. Fixtures cover iOS 17 only, unavailable iPhone, iPad-only, newer runtime chosen, tied names ordered by UDID, malformed JSON, zero total, all skipped, failedTests>0 and unknown result schema. Require nonzero in every invalid case and no accidental UDID/debug text on stdout.

~~~typescript
test("a successful process with zero tests is an unmet gate", () => {
  const file = join(tempDirectory, "zero.json");
  writeFileSync(file, JSON.stringify({
    totalTestCount: 0, passedTests: 0, failedTests: 0, skippedTests: 0
  }));
  const result = Bun.spawnSync(["python3", "native/scripts/check-core-results.py", file]);
  expect(result.exitCode).not.toBe(0);
});
~~~

tempDirectory is created with mkdtempSync(join(tmpdir(), "core-gates-")) in beforeEach and removed in afterEach. Import fs/path/os from node built-ins. Add CI source assertions that Kit test filter is scoped, core and simulator have no opt-in, xcodebuild/indirect scripts are wrapped, generic build and real-device tests both exist, and UI remains advisory.

- [ ] **Step 2: Run red, then implement the portable wrapper.**

~~~bash
gate core-gates-red bun run test --test-name-pattern 'native core gates'
~~~

Expected missing wrapper/lane assertions; Task 2's selector may already satisfy fixture checks. Implement wrapper using runner-local advisory file locking and foreground subprocess, no background lock holder, no stale process killing:

~~~bash
#!/usr/bin/env bash
set -euo pipefail
exec python3 - "$@" <<'PY'
import fcntl, os, pathlib, subprocess, sys, time
if len(sys.argv) < 2:
    raise SystemExit("usage: uitest-lock.sh command [args...]")
directory = pathlib.Path(os.environ.get("RUNNER_TEMP", "/tmp")) / "shepherd-uitest"
directory.mkdir(parents=True, exist_ok=True)
with (directory / "lock").open("a") as lock:
    deadline = time.monotonic() + 2700
    while True:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.monotonic() >= deadline:
                raise SystemExit("timed out waiting for serialized xcodebuild")
            time.sleep(1)
    result = subprocess.run(sys.argv[1:], check=False)
    raise SystemExit(result.returncode if result.returncode >= 0 else 128 - result.returncode)
PY
~~~

Mark executable. OS releases advisory lock when holder exits; no PID guessing. Tests check command exit 23 remains 23, argv with spaces remains intact and missing argv fails. Do not introduce concurrent test jobs merely to test serialization in this sequential run; inspect lock lifetime around child and use existing wrapper behavior as the operational constraint.

- [ ] **Step 3: Scope existing CI Keychain coverage exactly.** Keep native.yml/shepherdkit identity, temporary CI Keychain setup/cleanup and sentinel. Change its opted-in step to:

~~~bash
set -euo pipefail
swift test --package-path native --no-parallel --filter ShepherdKitTests 2>&1 | tail -n 40
~~~

The existing step-scoped SHEPHERD_KEYCHAIN_TESTS: "1" belongs **only** here. No job/workflow-wide opt-in. Add a separate step:

~~~bash
set -euo pipefail
unset SHEPHERD_KEYCHAIN_TESTS TEST_RUNNER_SHEPHERD_KEYCHAIN_TESTS
swift test --package-path native --no-parallel --filter ShepherdAppCoreTests 2>&1 | tail -n 40
~~~

Require nonzero Kit/core executions, compare identities and pass/skip counts, retain the original Kit sentinel execution. Package build includes both targets. Retain strings/contract freshness, Release/signature checks and Mac unit run. Wrap every existing xcodebuild -version and every build-app.sh/test-app.sh invocation with native/scripts/uitest-lock.sh; never lock twice.

- [ ] **Step 4: Add blocking core simulator lane.** Add job shepherd-app-core-simulator, macos-latest, needs: shepherdkit, no continue-on-error, Swift 6.2+ toolchain check, same required checkout/Bun/dependency setup conventions as existing lane. No new dependency versions. Run generation freshness, deterministic available-device selection, G3 generic build and concrete simulator tests. Use UITEST_LOCK="$GITHUB_WORKSPACE/native/scripts/uitest-lock.sh" and runner-local evidence paths. Publish xcresult plus secret-free summary using the repository's existing artifact action version; fail on zero/omitted mapped core identities.

Keep path filters native/**, contracts/**, ui/messages/*.json and native.yml. Keep existing shepherd-mac-ui continue-on-error: true and make its needs chain follow the simulator lane so native jobs in this workflow run sequentially; do not misrepresent it as a formerly blocking job. Other workflows' existing required checks remain as-is. No local background or concurrent hosted dispatch to speed acceptance.

- [ ] **Step 5: Run green tooling checks, then only invalidated/full-final gates.**

~~~bash
gate core-gates-green bun run test --test-name-pattern 'native core gates'
gate ci-format ./node_modules/.bin/prettier --check \
  .github/workflows/native.yml test/native-core-gates.test.ts
gate conservation bun run native/scripts/test-conservation.ts --check
~~~

Reuse G1/G2/G3/G4 evidence if source/command semantics remain valid. Changed scheme/wrapper/CI invocations require a foreground execution of the changed path, with exact command and environment. Run G5 against operator environment; compare to unchanged-base live evidence where available. Validate queue recomputation/terminal input disabled and getBranchStatus audit exclusion preserved; audit every live suite and UI test-token cleanup. Missing credentials/toolchain/SDK means UNMET, not skipped acceptance.

Record final identity census: original Mac retained + core moved =1090, Kit=416, UI=13; new additions separately. Core cases run on macOS and simulator; Mac integration-only scenarios run Mac. Result summaries account for parameterized cases, skips, old→new suite names and platform-specific execution expectations.

- [ ] **Step 6: Commit/report; fresh deep review.**

~~~bash
git add .github/workflows/native.yml native/scripts/uitest-lock.sh \
  native/scripts/select-core-simulator.py native/scripts/check-core-results.py \
  test/native-core-gates.test.ts
git commit -m "ci(native): gate shared core on iOS simulator and isolated tests"
~~~

Stage optional scheme only if changed. Report lane statuses accurately, all local/live unmet gates and artifact paths. Do not create a PR or merge with unmet required acceptance.

### Task 5: Document ownership and finalize acceptance evidence

**Tier:** light; review std. Mechanical documentation/ledger changes only.

**Files:** native/docs/development.md; native/scripts/gen-strings.sh descriptions; approved spec/plan status; .superpowers/sdd/progress.md and task reports (local, never force-added).

**Interfaces:** Documentation describes the implemented signatures from Task 2, selector/result inputs and actual gate commands from Task 4. No new code contract.

- [x] **Step 1: Update development.md with these concrete sections/content.** Replace old app-model paths with native/Sources/ShepherdAppCore paths; document S→C split and the retained Mac local-server exception. Include target graph, AppExtension register/current-activation ownership and reverse teardown, required AppModel notifications argument, StreamHost prompt/scene/model callbacks and exact install order, configure-before-scene requirement, reset preserving host, direct installers/previews, view-free core, generated catalog copy plus EN/DE processed strings and test bundle accessor. Show G2/G3/G4 commands with lock wrapper and no Keychain opt-in. State iOS skeleton and view extraction are later work, not delivered.

- [x] **Step 2: Reconcile every acceptance checkbox against evidence.** Mark spec criteria complete only where recorded passing evidence exists. Record baseline→final identities and exceptions unchanged. Link tested SHA/environment/commands and CI URLs after Task 6; do not claim CI success in advance. Update generator shell comments to name all three generated module outputs.

- [x] **Step 3: Validate documents without rerunning product gates.**

~~~bash
gate documentation-format ./node_modules/.bin/prettier --check \
  native/docs/development.md \
  docs/superpowers/specs/2026-09-21-shepherd-app-core-stage-1-design.md \
  docs/superpowers/plans/2026-09-21-shepherd-app-core-stage-1.md
git diff --check
~~~

Use formatter --write only on the changed documentation when necessary; recheck those files. This task has no product red/green: its meaningful checks are link/path/signature reconciliation and formatting, not invented behavior tests.

- [x] **Step 4: Commit/report.**

~~~bash
git add native/docs/development.md native/scripts/gen-strings.sh \
  docs/superpowers/specs/2026-09-21-shepherd-app-core-stage-1-design.md \
  docs/superpowers/plans/2026-09-21-shepherd-app-core-stage-1.md
git commit -m "docs(native): document shared core composition and validation"
~~~

Report acceptance/evidence matrix and any UNMET entries. Fresh std review checks docs against actual APIs using existing evidence.

### Task 6: Whole-branch review, sequential fixes, CI and squash handoff

**Tier:** deep; fresh final deep reviewer after fixes. Whole-branch integration review with explicit scoped fix permission.

**Files:** Read complete Stage 1 diff against origin/main and evidence index; only fixes within approved extraction files/requirements. .superpowers/sdd/progress.md stays local. No unrelated cleanup.

**Interfaces:** Input is accepted Tasks 1–5, spec, original identity map, current SHA, gate reports/result artifacts. Output is PASS/FAIL/UNMET with concrete findings/evidence, then one Stage 1 PR when ready. Orchestrator handles final merge.

- [ ] **Step 1: Dispatch fresh deep whole-branch review with fix permission.** Brief explicitly permits narrowly fixing found extraction defects, committing each fix and running only affected focused checks. Review prompt must cover view-free semantic boundary, minimal public API/default arguments, no duplicated bodies, lifecycle/stale actions/reconnect races, exact interleaved install order, reset owner release/prompt renderer, Mac notification/focus ordering and isolated launch, package runtime resources, every original scenario identity, no new unsafe annotation, CI Kit-only opt-in, signing and all five Review Focus scenarios.

~~~bash
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
git log --oneline origin/main..HEAD
~~~

Read source diff in ≤300-line chunks; no whole generated catalog/contract dumps. Verify contract generated semantic changes are absent. Reviewers reuse passed full gates; a suspected issue must name its concrete reason before asking for a rerun.

- [ ] **Step 2: Fix/review sequentially until no unresolved finding.** If review can fix within its permission, it commits fix and reports touched files/invalidated evidence; then a fresh deep review verifies it. Larger fixes use a fresh implementation run at light/mid/std/deep according to actual work, followed by fresh review. The orchestrator does no product edits. No concurrent reviewer/fixer or parallel gate. Each fix commit has a concrete message and report; do not squash locally to hide review evidence.

- [ ] **Step 3: Establish current origin/main ancestry by rebase only.** Dispatch a fresh light mechanical run if refresh needed:

~~~bash
git fetch origin main
git rebase origin/main
git merge-base --is-ancestor origin/main HEAD
~~~

Resolve nonmechanical conflicts via fresh appropriately tiered run and fresh review. Never merge main or another feature branch. Compare changed files after rebase and rerun only evidence invalidated by conflicts/base changes; a no-conflict rebase still requires assessing changed dependencies/contracts, not assuming all evidence valid.

- [ ] **Step 4: Publish exactly one Stage 1 PR after local acceptance is complete.** Future authorized execution only; no push/PR during planning. Use a fresh light run for push/PR preparation and the orchestrator for final merge. PR title “refactor(native): extract ShepherdAppCore (Stage 1)”. Body leads with shared core behavior, retained Mac responsibilities, exact test conservation/migration, simulator execution, approved unchanged Kit exceptions and evidence links. Use a temporary body file with actual newlines and gh pr create --body-file; no command-substituted Markdown or secrets. Link #2431 as Stage 1 of the still-open multi-stage issue; do not close the whole issue early.

- [ ] **Step 5: Wait for all required CI results and inspect failures sequentially.** All required checks must be green, including new simulator lane; advisory Mac UI status is reported accurately and local isolated UI/live evidence remains mandatory. Never override red/pending checks, skip the Kit sentinel or treat missing secrets as green. CI failures use fresh fix run/review with narrow invalidated gates. Reuse CI artifact evidence rather than repeating passed full suites locally. Poll bounded summaries, not entire logs.

- [ ] **Step 6: Fresh final deep verdict, then orchestrator squash merge only when green.** Verify PR head SHA matches reviewed/tested SHA, ancestry and current CI, no unresolved Review Focus or acceptance item, source census/runtime mapping complete, read-only live smoke and cleanup proven. Orchestrator executes gh pr merge with --squash and --match-head-commit set to that reviewed SHA after green required checks. Recheck/redo review only when a changed head invalidates it. No merge commit, auto-merge while acceptance is unmet or bypass.

- [ ] **Step 7: Final report/ledger.** Record PR URL, merge SHA, tests/evidence, retained platform list and remaining Stage 2/3 scope. No product implementation is authorized by completion of this written plan alone.

## Inline self-review and coverage

- Spec boundary/public API/inventory: Task 2 moves the whole cyclic graph and every approved split; no intermediate broken-import task or duplicate implementation checkpoint.
- Composition/lifecycle: Task 2 owns configure-before-scene, direct/full installer reuse, exact order, prompt fallback, reset/release, conservative seams, activation generations, reverse teardown and weak current-model lookup.
- Notifications: Task 2 defines synchronous focus sample/observe/cancel and unchanged center contract; preserves fake isolated settings policy, click/start/subscription/sample/task order and teardown-clear ordering.
- Resources: Task 2 provides all three generated outputs and correct package rules; Task 3 checks escaping, all-key EN/DE bundle resolution/formatting on both platforms and actual Mac consumption.
- Test conservation: Task 1 captures real original identities and runtime evidence; Task 2 maps every relocation/split; Task 4 compares both platforms, Kit and UI with additions/skips separate. No total-only conservation or omitted live scenario.
- Validation/CI: Tasks 2/4 own root/package/simulator/Mac gates and core/Kit isolation; Task 4 closes read-only live gate; Task 6 requires green CI and final reviewed head before squash.
- Documentation and scope: Task 5 updates actual paths/signatures/gates; Tasks 5/6 report later stages without delivering them.
- Review Focus 1/2/3 map to concrete Task 2 tests; 4 to Task 3; 5 to Tasks 1/4. Every owning task names red/green or an evidence-specific check.
- Task 5 performed documentation-only reconciliation against the recorded Task 1–4 source and evidence reports. It did not rerun product gates, access credentials, use agents, or publish a PR. Formatting and whitespace checks are the task-level validation.
- Written-plan review is complete for the executed Tasks 1–4; Task 6 remains the final whole-branch review and hosted/live acceptance handoff. Execution remains sequential.
