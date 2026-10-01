# Plan decisions on iOS

The session detail includes a **Plan** tab whenever a session has a plan phase or
an existing gate. The tab uses `PlanModel`, `PlanTabActions`, `QuestionFormModel`,
`PlanGateChip`, `PlanEnvironment` and `VisualFileTree` from `ShepherdAppCore`, and the
existing generated-client plan routes from `ShepherdKit`.

The iOS sidebar already installs `PlanModel` before Herd reads the review signal.
`IOSPlanStream` adds the unanswered-question signal and reuses that registration.
Session actions, ready-PR merge and composer registrations remain installed alongside
Plan. The detail actions bar remains visible on the Plan tab, and list cards retain
the session action swipes. There is one store event connection, and the existing sidebar recovery refreshes
plan snapshots after foreground entry and reconnect.

A planning session with unanswered questions, a ready gate, a blocked/paused
operator turn or an exhausted review budget opens directly on Plan when its list
card is selected. Other sessions retain the terminal-first default. Plan/Answer
badges and the detail header identify that destination; VoiceOver announces the
row's destination. The Plan tab remains reachable during execution for inspection.

## Actions and request ownership

The actions follow `PlanPanel.svelte` and the Mac Plan tab: **Review**, **Go**,
and stalled-plan **Resume/Dismiss**. Go requires the server's approved gate and
confirmation for that exact verdict. Review is available for an edited executing
plan, matching the web; unchanged executing plans are read-only.

Single choices, optional multiple choices and multiline text answers use the
shared form validation, index-based payloads and confirmation. Requests show
progress, preserve drafts on error and prevent repeated submission. Answers
recorded without delivery show the shared warning and remain locked. Persisted
answered forms are read-only. The reviewed plan hash, block identity, contents and session activation
fence stale confirmations and completions. Identical questions in a new revision
receive a fresh form and require new consent.

The web's stalled-plan **Prepare steer** editor is also available. Its editable
findings can include an operator note and are sent with the existing reply route.
This requests a plan revision; it does not set an approval or rejection verdict.
The current contract has no operator approve/reject-with-note endpoint. iOS uses
Go to release an already approved plan and never bypasses that server rule.

Writes require the current selection and activation, a live connection, a current
nonarchived session in the live store, a mounted foreground view, enabled input
and no isolated read-only request audit. Question,
steer and plan requests lock competing controls. `IOSPlanController`, registered
as an activation-scoped `AppExtension`, retains per-session forms, steer drafts
and outstanding request locks across tab and detail navigation. Inactive views
cancel pending consent and invalidate presentation feedback without releasing
request locks. Successful answer/steer delivery remains recorded even when its
presentation has left, preventing a second delivery. Profile teardown drops the
activation owner and fences old completions.

Initial detail entry uses the current list selection gesture. Historical
`openPlanTick` values form a baseline; only newer requests can switch a mounted
detail to Plan. Reopening an executing session therefore starts on Terminal. No new contract
or Mac behavior is introduced.

## Phone presentation and visual evidence

The views use the existing terminal palette and scaled monospaced fonts. Choices
are full-width buttons with a minimum 44-point target, selected accessibility
traits and question/option labels. Tables become labelled records; file paths and
prose wrap. Dynamic Type is uncapped and the production Plan body scrolls.

Rich text, callouts, file trees, checklists, tables, code, data-model fields,
endpoint summaries and question forms render natively. Mermaid source and diff
summaries/annotations remain readable without a graphical diagram or full diff.
Wireframe HTML is never rendered; its caption and the existing omission message
are shown. Unknown block types remain inert, as on Mac.

`IOSPlanTests.testRenderKeyStatesToPNG` uses `ImageRenderer` with fixtures in the
production view bodies. As with the existing terminal fixtures, UIKit-backed
scroll containers, editable fields, progress spinners and text selection are replaced
with static current values for export. This is layout evidence, not simulator screenshots or
live-server acceptance. The test does not boot or operate iPhone 17 Pro.

Outputs are written to the stream's supplied scratchpad `ios-plan` directory:
`detail-plan.png`, `list-attention.png`, `list-attention-large.png`,
`plan-ready.png`, `plan-questions.png`, `plan-questions-large.png`,
`plan-stalled.png`, `plan-steer.png`, `plan-reviewing.png`, `plan-error.png`,
`plan-readonly.png`, `plan-isolated.png`, `question-error.png`,
`question-submitting.png`, `question-undelivered.png` and `plan-visual-blocks.png`.

Run iOS build/tests only through the operator's `ios-shared-build.sh`, selecting
the `ShepherdIOSTests` unit target for fixtures. The source-inventory validator
must confirm every unit identity executed successfully. Device VoiceOver,
keyboard scrolling and live-server decisions still need manual acceptance.

`IOSPlanTests` includes regression cases for identical-question plan revisions,
buffered consent and late completion, answer/steer/review/quota locks across tab
remounts, live-store archive exclusion for every plan write, and Terminal-first
reentry after execution with historical plan-open ticks.
