# iOS session actions

Stream A adds session steering to the terminal-first iOS detail without changing
Mac views or the Plan gate approval UI.

## Placement

Mobile web uses `CardMenu.svelte` for Stop, Resume, Rename, Amend and Relaunch,
`viewport/ViewportHeaderActions.svelte` for detail Resume/Rename, and
`git-rail/RailStatusActions.svelte` for Ready and Merge. `UnitRow.svelte` reserves
its phone swipe for Decommission. That action is outside this stream.

The iOS detail header menu holds every available command, including eligible Merge.
While the session's PR is open, a **merge card** sits above the steer capsule (#3542),
the iOS counterpart of the web's merge row (`viewport/PrActionRow.svelte`). Without an
open PR, only Ready is repeated above the terminal footer. Recap opens from Info. The header owns Rename, Amend,
Relaunch and Merge confirmation sheets, keeping them reachable across tabs.
Errors, progress, outcome notes and read-only copy remain inline above the footer
or other tab content.

The list exposes **Stop, Resume and Ready** as state-dependent trailing swipe
buttons and context-menu commands. These are the web's quick lifecycle/handback
controls: Stop and Resume are near the top of the card menu, and Ready is the git
rail's direct operator toggle. Usually only one or two apply. This is a deliberate
placement difference from web's Decommission swipe, not a claim about usage
analytics. Full swipe never executes a command. System swipe buttons expose
VoiceOver actions; the detail also offers explicit labeled buttons and a menu.
Dynamic Type is uncapped; menus and sheets keep commands reachable at larger
text sizes. Controls have at least a 44-point hit target.

## Merge card

`MergeRowRules` ports `pr-action-row.ts`: the state (merging, draft, conflict, behind,
CI failed, CI running, protected, ready), the lock reason (`gitrail_merge_blocked_*`)
and the fact line (CI · critic · base · conflicts). A fact the host did not measure is
left out; the critic fact appears only with a verdict or a running review, because
iOS does not know whether the repo runs the critic. Like the web row, any failing or
pending check locks Merge here.

- **Left:** status glyph and label, `#<nr>` and title on one line, the facts in mono caption.
- **Right:** a 44 pt ⋯ menu (Review/Re-review once CI has cleared, Mark not ready, PR ↗,
  Merge with options …) and the main action, at least 48 pt high.
- **Main action:** Mark ready while the session is not handed back. Otherwise
  **PR mergen** as a hold: about 1.2 s, the button fills amber from the left with a light
  tick per quarter and a success haptic at 100 %. Releasing early cancels. The hold sends
  the same `confirm` stamp as the sheet, built from the PR the card shows, with the
  server's merge method and branch deletion. A drifted PR fails with the stale refusal
  and nothing is merged.
- **Takeovers** (`IOSMergeConfirmationFacts.isTakeover`) never hold: a tap opens the
  confirmation sheet with the responsibility notice.
- **Locked:** the status and facts say why; VoiceOver reads the reason as the hint.
- **Accessibility:** VoiceOver and Switch Control activation and the named action open
  the sheet, since holding is not reasonable there. Reduced motion fills without
  animation and shows the progress as a percentage. Accessibility text sizes stack the
  card vertically. The card is a container named "Pull request #<nr>".
- Merging shows "Merging …" and locks the button; errors appear inside the card.
  The card is hidden in focus mode and while a Claude dialog is open; read-only keeps
  its note.

## Reuse and lifecycle

`ActionsModel.actions(for:)` applies `ActionRules`, including terminal, archive,
working-blocked and merged-session guards. The iOS Ready toggle also requires an open PR or an
already-ready session, using the Herd git cache like the web rail. `SessionCommandState` serializes writes,
`ActionBarOutcome` supplies inline notes, and `RenameSubmission`, `AmendSubmission`
and `ActionErrorCopy` provide validation and localized outcomes. The iOS layer
changes the Ready button label to an explicit verb while keeping the core notes.

The existing read-only sidebar installer already registers ActionsModel and
MergeModel. `installIOSSessionActions` registers them idempotently and connects
the four `MergeInputs` closures exactly like the Mac Wave 2 installer, without
requiring a Mac `StreamHost`. This new shared-core installer compiles only on iOS.
`IOSSessionActions` is an activation-scoped extension holding the command state
shared by each session's list and detail controls. It uses the existing event
connection and core recap stream; it adds no socket or contract operation.
Its cache reconciles against live sessions and the selected Done session. Removed
states are invalidated after any in-flight command completes, preserving an
archiving relaunch until it can select its replacement.

Every write checks the current activation, store and read-only policy. The same
checks run behind the controls, so a disabled UI is not the only protection.
Profile changes invalidate presentation and late outcomes. Sheet completions
also require the current selection; an archiving relaunch may select its
replacement only while the original remains selected or its archive cleared the
selection. An explicit move to another session cannot be overridden.

## Confirmation and feedback

Stop matches the web's reversible per-agent interrupt and executes directly.
Relaunch presents repository, base branch and prompt overrides, explains that the
original worktree will be discarded, and requires an explicit destructive submit.
Only changed overrides are sent; provider/model/effort and other settings inherit
from the original. Blank fields and prompts above 8,000 UTF-16 units are rejected.
Rename and Amend require explicit submit; failures retain their drafts. Amend
uses the shared 2,000 UTF-16-unit limit and distinguishes recording from delivery.

Merge is offered for a ready, open PR outside review using `MergeRules.ready` and
`MergeInputs`. It fetches fresh git state before showing repository, PR, target,
head revision and any server-stamped handoff/reviewer responsibility. The sheet
defaults to **Server default**, omitting `method` so the host's `forge.mergeMethod`
applies, as on web. Squash/merge/rebase are explicit overrides; branch deletion
remains selectable. GitState currently does not expose the web's configured
merge-method field. Cancel receives
initial VoiceOver focus. Confirmation stays disabled for 350 ms, and the command
checks elapsed time again. Unknown responsibility values fail closed.

`MergeConfirmationRules.payload` echoes the fresh stamp to the server. A failure
spends the candidate and closes the sheet; retry fetches new state and needs a new
confirmation. MergeModel serializes merge operations globally; each originating
session owns its progress and server refusal copy. Other sessions' lifecycle
commands remain available, and background snapshot errors stay in MergeModel.
Commands show
progress, core success/warning notes and localized failures in both list and
detail. Isolated/read-only launches suppress swipe commands and disable detail
writes without sending rejected audit requests.

## Visual fixtures and limits

`IOSSessionActionsTests.testRenderFixtureImages` uses SwiftUI ImageRenderer with
contract-shaped fixture data. It writes running, ready, large text, read-only,
Amend, Relaunch, Merge facts, Recap, progress/error and success PNGs to the scratchpad
provided in the stream brief. No operator simulator is booted or installed.
UIKit-backed TextEditor/Picker/Menu/Toggle controls use static labels or
checkboxes inside the production field layout; the progress fixture uses an hourglass because UIKit-backed controls do not draw into ImageRenderer.

The recap sheet displays the core verdict/headline, body, open items and changed
files. Rich visual recap blocks remain a web/Mac parity gap. Variant/continue
provider pickers, Decommission, automation controls, build-queue commands and merge
trains are outside this stream. Plan approval/rejection remains another stream.
These fixtures and injected command tests do not constitute a live-server or
hardware acceptance run.
