# Epic controls on iOS

The herd's epic identity (repo, title, parent number, badge and progress) opens its
large detail sheet, even before the graph has loaded. The separate 44-point
chevron only folds the group. Running epics offer Pause; paused epics offer Resume.
A running attended epic with a ready child also offers Approve next.

Detail reuses `EpicDigest`, `EpicFlow`, `EpicChain`, `IOSEpicMeter`, the run chip and
session-list typography. It groups children into Now, Up next, Waiting and Done.
Tap an in-flight child to open its listed session; other children open their own
sheet with dependency context, issue/PR links and an expandable plain-text body.
Ready or blocked children without a session open the existing iOS composer with
`ComposeModel.pickIssue`, scoped to the epic's server and repository. Submission
still requires the composer's explicit Start action. A session that is no longer
listed is identified as unavailable.

The Abarbeitung card edits mode and provides Pause, Resume, Approve next and a
confirmed Stop. Agent settings reuse the composer's provider model/effort lists.
Starting sends `status: running` with the selected settings; editing an active or
paused epic leaves status absent. A usage-ceiling override is sent only when the
resulting run is running, matching the server's validation.

Starting or resuming first reads the repo's drain summary. If another epic leads,
the operator can requeue it at the head of the queue, supersede it without
queueing, or cancel. A failed read prevents a blind takeover. The server currently
has no conditional-start revision, so the check and write have the same race
window as the web client. Stop ends new starts, retains in-flight sessions and can
promote the next queued epic.

`IOSEpicControl` shares request ownership, busy state and inline errors between
header and detail. Returned graphs update `IOSEpicDirectory` immediately; older
reads cannot replace a mutation. `epic:update` events refresh visible groups and
detail reloads on opening. Store, profile and activation checks discard stale
responses. Isolated read-only launches expose no mutation controls.

`ShepherdClient.updateEpic` and `approveEpicNext` wrap the existing generated
operations. They map documented failures and re-read the graph for the contract's
`{ok:true}` response. If that graph has disappeared, the caller receives the read
error instead of a fabricated successful graph. No contract or Mac behavior changes.

The iOS controls do not include web queue management, agent-slot editing,
integration-base recovery actions or drain hold diagnostics. Clock and forecast
reuse the existing native summaries. Parent and PR links derive from a child's
issue URL; no child issue URL means no parent link.

`IOSEpicControlTests` covers action policy, links, settings patches, takeover
confirmation, request serialization, activation changes, stale reads, approval and
composer attachment. Its render test hosts the production views in a private test
window, then exports through `ImageRenderer`. Set `SHEPHERD_EPIC_RENDER_DIR` (and the
`TEST_RUNNER_` spelling for hosted tests) to choose an output directory; CI defaults
to its test sandbox. It never screenshots the operator's simulator. Renderings
are fixture layout evidence; live-server, VoiceOver and physical-device acceptance
remain separate checks.
