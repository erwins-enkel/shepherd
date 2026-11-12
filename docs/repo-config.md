# Shared repository rules

Shepherd reads repository rules from `.shepherd/config.json` on the default branch of
`origin`. Saving changed rules creates one `chore(shepherd): set repo rules` commit,
including all rules selected in that save. Shepherd pushes to the default branch when
allowed; a remote rejection on a non-fork repository creates or updates a rules PR.
The checked-out branch, working tree and index are untouched. Saving unchanged rules
does not create another commit.

```json
{
  "criticEnabled": true,
  "autoDrainEnabled": false,
  "defaultModel": "inherit",
  "defaultEffort": "inherit",
  "leitrechner": null
}
```

`leitrechner: null` leaves repository jobs unassigned. To restrict them to one machine,
select its persistent instance ID in the UI; do not put a hostname or a credential here.

## The three settings layers

| Layer                                | Stored in                                     | Effect                                                                      |
| ------------------------------------ | --------------------------------------------- | --------------------------------------------------------------------------- |
| Repository rules — for all machines  | `.shepherd/config.json` on the default branch | Shared critic, autopilot, merge, backlog and other rule values              |
| Lead machine (Leitrechner)           | `leitrechner` in the same file                | Chooses the one machine allowed to start new backlog and all-PR critic work |
| Machine settings — only this machine | Each machine's local database                 | Limits, sandbox, browser/network permissions and other local values         |

The lead-machine selection does not move sessions or synchronize machine settings.
Global settings remain local too. Existing sessions use the repository rules on the
machine where they run; the Leitrechner gate only controls new repository-wide jobs.

## Set up shared rules

1. Run a compatible Shepherd checkout on each machine. Register a clone of the same
   forge repository on each, with working `origin` read/write access. Checkout paths may
   differ; the forge slug (`remoteSlug`) identifies the project. Configure the participating
   machines' connections consistently in both directions; see [connected machines](machines.md).
2. In the web UI, open **Backlog → Settings** for the repository. Sections distinguish shared
   rules from machine values. Shared edits stay in a draft across sections. Review the changed
   values and target branch, then confirm one save. Without a file, **Set for all machines**
   publishes the current rules. This web flow starts from the current machine's rules;
   use the iOS comparison to choose differing values from multiple machines.
3. In iOS, open **Repos**, then the settings button beside the project's forge slug. One
   connection to a coordinator is enough; it reads the other machines. If no valid file exists
   and rules differ, choose **Merge differences**, select a machine's value for each differing
   rule and choose the Leitrechner when requested. Review equal rules too, then choose
   **Save as repository rules**. The selected rules and leader are saved together in one commit.
   An incomplete comparison only covers the reachable machines; restore connectivity before
   treating it as agreement between all machines.
4. For later iOS edits, change the shared rules, review all changes and confirm. Select the
   machine separately for local values: those save immediately without a rule commit.
5. Check the save receipt and each machine's rule values and commit SHA. A failed peer
   notification leaves the save intact but means adoption needs checking. A pending PR must
   merge before its proposed rules become effective; see [protected branches](#protected-default-branches).

Without a valid file, each machine keeps its previous local rules, including independent
backlog processing. Choose a Leitrechner explicitly when publishing the first shared rules
if only one machine should claim repository work. Local-only and lightweight repositories
cannot publish shared rules; their settings stay local.

## Fields and precedence

The shared fields are `criticEnabled`, `criticAllPrs`, `criticSmellLensEnabled`,
`autoAddressEnabled`, `autopilotEnabled`, `planGateEnabled`, `autoDrainEnabled`,
`autoMergeEnabled`, `buildQueueEnabled`, `draftMode`, `signoffAuthority`,
`manualStepsIssueEnabled`, `preWarmEpicLandingCi`, `epicStacksEnabled`, `autoLabel`,
`defaultModel`, `defaultEffort` and `leitrechner`.

With a valid file, every shared field comes from that file. An omitted field gets
Shepherd's default, **not** the machine's saved database value. An empty object therefore
selects all defaults. `inherit` for model or effort follows the global default on each
machine; machines can resolve it differently. The API retains the literal `inherit` value.

All other settings stay in the machine's database: concurrency and usage limits, sandbox,
browser and egress settings, local preview scripts/commands, repo mode and visibility,
CLI provider/execution effort, priority labels, connector access and plugin/skill allowlists.
A commit cannot grant local sandbox, browser, connector or network permissions. Switching
the local CLI does not rewrite shared model/effort rules; incompatible shared overrides use
the existing provider-specific fallback when starting sessions.

Unknown file keys are ignored and are not emitted on save. Retired `learningsEnabled` and
`autoOptimizeFlagged` keys have no effect. The JSON must be an object; known fields require
valid types and setting values. Malformed JSON or invalid known values makes the whole file
ineffective, preserving the previous database behavior. Draft mode combined with auto-merge,
or with critic-dependent signoff while the critic is disabled, also makes the file invalid.
Such files cannot block local safety edits such as revoking Shared Browser or tightening
the sandbox. Existing database rules are retained as a fallback. With no `origin`, or in lightweight mode, existing settings remain local and no
configuration file is read or created.

## Reading and saving

Reads use the committed `origin/<default>` tip, falling back to the local default branch
only if the remote-tracking ref cannot be resolved. A missing or invalid file at the remote
tip does not reactivate an older local file. The default branch is discovered from
`origin/HEAD`, falling back to `main`. GET never fetches. After fetching on another machine,
allow up to 60 seconds for the read cache to expire. Successful writes refresh the cache
immediately.

GET and successful PUT responses include:

- `fieldSources`: a source for each configuration field, `repo` or `rechner`. Missing shared
  fields filled with defaults and literal `inherit` values still have source `repo` when a
  valid file is active. Response metadata is excluded from this map.
- `repoConfigBranch`: the exact default branch used for shared-rule commits, including before
  a file exists; `null` for local-only or lightweight repositories. Omitted when forge discovery
  fails; the panel blocks rule edits and offers retry until the target is known.
- `repoConfigCommit`: the full selected default-branch commit SHA, or `null` when no valid
  file is active (missing, invalid or disabled).

The first explicit shared-rule write seeds a complete file from the machine's current
rules, then applies the edit. Further edits merge into freshly fetched rules. Shared-rule
edits retain the draft/auto-merge and critic/signoff validation rules. A request containing
only machine fields never creates a commit or initializes a file.

For a mixed request, machine fields and automation confirmation are saved after the rule
save succeeds, including a successfully published PR proposal. The proposal remains pending
while machine values take effect locally. A failed fetch, push or PR publication returns
HTTP 502 with `code: "repo_config_write_failed"`; local changes are not applied. Check
origin and forge write access before retrying. Authentication, network and non-fast-forward
failures are errors, not reasons to create a PR. Shepherd never force-pushes the default
branch. Remote Git and local SQLite do not form a distributed transaction across process
crashes or storage failures.

## Protected default branches

If the remote rejects a direct push (for example, protected `main`), Shepherd publishes the
same rule change on `shepherd/repo-config` and opens one PR against the default branch.
The save response includes `pendingRepoConfig` with its number, URL and proposed changes.
Web and iOS show the waiting PR link. **The default-branch rules remain effective until
merge**, including the existing Leitrechner selection. With no valid default-branch file,
the local database rules remain effective while the first proposal waits.

Further saves from either machine update the same open proposal, preserving its intended
changes and rebasing them onto the latest default-branch rules. Updates to the proposal
branch use an explicit ref lease; a competing save can fail rather than overwrite another
machine's change. Retrying an identical pending proposal adds no commit. Fork repositories
do not use this fallback.

Review and merge the linked PR through the forge's normal process. Then refresh the
participating machines and verify their effective commit and rule values. A PR save does
not notify peers to adopt unmerged values. Closing a proposal without merging does not
apply its rules. Do not repeat Save merely because a successful save's follow-up read or
peer notification failed; check the receipt and PR first.

## Connected machines

A client needs only its coordinator. `GET /api/repo-config/project?remoteSlug=<forge-slug>`
returns the reference rules, leader, each machine's effective configuration and reachability,
and a comparison of machine rules when no valid file exists. Slugs use the same identity as
`GET /api/repos`, including a fork's origin slug. The coordinator need not own a checkout.
The local machine is the preferred read reference; otherwise the first answering peer by
instance ID is used. Each machine retains its own commit SHA: the reference is not a claim
that all peers have fetched that SHA.

`GET /api/repo-config/machine?remoteSlug=<slug>&instanceId=<uuid>` reads one machine.
PUT at that URL accepts only machine fields and optional `automationConfirmed` metadata,
uses that machine's existing validation and immediate side effects, and never commits.
`resolvedRunDefaults` reports that machine's provider/model/effort resolution while shared
rules retain the literal `inherit` setting. There is no fallback to the coordinator's DB.
Unknown targets return 404; unreachable or incompatible targets return 502.

`PUT /api/repo-config/project?remoteSlug=<slug>&instanceId=<uuid>` accepts
`{"rules":{"criticAllPrs":true},"leitrechner":"<instance-uuid>"}`. The selected machine
saves one rule commit, including the chosen leader, directly or through the rules PR. `leitrechner: null` clears
the selection. A leader is stored only as an instance ID, never a host name. This API records
the selection; execution gating of backlog and PR sweeps is owned by the leader feature.
The same PUT merges selected values from a no-file comparison. Rule and machine writes use
separate requests; existing path-based PUT remains available for combined local edits.

After a successful rule commit, the coordinator asks connected owners to fetch and invalidate
their rule caches, and refreshes its own checkout when another machine wrote the commit.
The response contains `notifications` with an outcome per target. A failed notification does
not undo the commit or change a successful write into a failed save: inspect each outcome
before deciding whether a machine has caught up. Machine-only edits do not notify peers.
`POST /api/repo-config/refresh?remoteSlug=<slug>` always acts locally and never forwards,
commits, changes the checkout or publishes another notification. Internal peer calls use
`host=local`, so mutual connections cannot create a forwarding loop.

On startup, registered non-lightweight repositories fetch their default refs before deferred
background jobs start. Offline-origin failures are logged and leave the last fetched rules
in place. A machine that missed a notification therefore catches up at its next successful
startup fetch or explicit refresh. Ordinary GETs remain network-free on the target.

When all compared machines lack a valid file, `differences.fields` names differing rule
fields and values per machine; `multipleAutoDrain` lists owners with backlog processing
simultaneously enabled. A missing peer makes `differences.complete` false and appears in
`unavailableInstanceIds`. Fewer than two usable machines cannot prove agreement. Mixed
file-backed and no-file states do not produce a migration comparison. An unsupported peer
API is an unavailable result, not evidence that the peer lacks the repository.

The new GETs are available to unrestricted read/submit/full tokens; writes require full
scope. Repository-restricted tokens and the agent ingress cannot use these federation routes.
Credentials stay on the coordinator and are sent only in Authorization headers to configured
peers, with redirects refused. Global settings and machine settings are never mirrored.

## Leitrechner (repository job owner)

Set `leitrechner` to the persistent ID from `GET /api/instance` using
`PUT /api/repo-config?repo=<path>`, for example `{"leitrechner":"<instance-id>"}`.
Use `null` to clear it. The selection and any other shared rules in the same request
produce one commit. It requires a forge repository with `origin`; the file stores
only the ID, never a hostname, URL or credential.

| Selection                    | New label-drain and all-PR critic starts       |
| ---------------------------- | ---------------------------------------------- |
| Missing or null              | Existing behavior on every machine             |
| This instance's ID           | Run here, subject to the existing repo toggles |
| A connected machine's ID     | Skip here, even while that machine is offline  |
| An unknown installation's ID | Ignore the selection; existing behavior        |

Known machines in checking, unreachable, unauthorized, incompatible or identity-mismatch
states do not authorize takeover. Removing a connection makes its ID unknown locally.
Connections must therefore be configured consistently on the participating machines.
There is no automatic switch. An offline owner means a pause until it returns or the
operator explicitly changes the selection.

Before starting these jobs, Shepherd fetches the default branch on its first attempt
after startup, then refreshes at least every 30 seconds while attempting jobs. Concurrent
attempts share the fetch. When the last known selection identifies this instance or a
connected machine, a failed fetch pauses new global starts until a successful retry,
rather than trusting stale ownership. Missing, null and unknown IDs preserve the existing
behavior even when fetching fails. GET remains network-free. A selection PUT
invalidates that machine's refresh immediately. Running work finishes normally; a manual
switch can overlap starts authorized within the previous refresh window. This is an
ownership rule, not a distributed atomic lock; existing issue-claim deduplication remains.

Session critics, autopilot, plan gates and merging existing sessions keep running on each
machine. Explicitly started epics and manual session starts also remain available. Epic
landing creation, rebasing, repair, review and auto-landing stay on the machine holding
the local epic record.

`GET /api/repo-config` includes `leitrechnerStatus` with the configured `instanceId`,
resolved `name`, `role` (`unassigned`, `local`, `remote`, `unknown`), nullable `reachable`,
`allowed` and `pauseReason`. Pause reasons distinguish `remote_leitrechner`,
`leitrechner_unreachable` and `config_refresh_failed`. These are derived metadata, not
writable rules. The `repo:leitrechner` event carries `{repoPath, leitrechnerStatus}` when
this view changes. Drain snapshots and `drain:status` carry the same ownership view;
a local explicit epic can still progress while the general repo jobs are paused.

## Change the Leitrechner by hand

1. Keep the old machine configured as a connection even if it is offline. In iOS open
   the project's settings and **Change Leitrechner**, then select an available machine.
   The sheet names the machine that will write the commit; it need not be the old leader.
   In the web Backlog's **Settings** tab, change the lead-machine selection and review the save.
2. Confirm **Commit Leitrechner change** in iOS, or the staged change in the web UI.
   For API clients, send the new persistent ID to the project PUT with an available
   `instanceId` as writer. Do not clear the leader as an intermediate step: `null` restores
   independent repository jobs on every machine.
3. If the save produces a PR, merge it before expecting ownership to change. Confirm the
   new value is on the remote default branch. Check each reachable machine's commit SHA,
   `leitrechnerStatus` and backlog status after successful refresh. The new leader must
   still have the relevant repository automation enabled and sufficient local capacity.
4. When the previous leader returns, it fetches before starting new repository jobs and
   sees the new owner. Verify that its new backlog/PR-sweep starts stay paused. If fetching
   fails with known ownership, it must remain paused until a successful retry.

Wait for successful fetches and an observed scheduler cycle when verifying the switch;
an empty queue or a single screenshot is not proof that takeover is disabled. Work already
running may finish, and starts authorized within the previous refresh window can overlap.
This procedure does not move existing sessions or local epic records.

## Web save boundaries

The web Backlog's Settings tab groups each section into shared rules, the lead machine and
local machine values. Rule edits remain a panel-local draft across sections until the operator reviews the old/new values, target
branch and fixed commit message. One confirmation saves all selected rules and the lead
machine in one commit. Without a file, “Set for all machines” publishes the current rules.
Machine values save immediately without a commit. Bootstrap, schedules and reviewer/merger
roles keep their separate save flows; role changes may create their own commit or PR.

## Two-machine acceptance

Use a dedicated test repository and isolated branch-checkout backends on a real Linux
machine and MacBook, with the matching iOS app. Do not interrupt a production host to
simulate an offline leader. Keep both configured connections during that test and stop
only the isolated leader backend or interrupt its test connection.

The [two-machine acceptance record](acceptance/repo-settings-two-machines.md) gives the six
scenarios, required observations and evidence fields. Local regression tests and simulator
checks support that record; they do not replace real-device Web/iOS acceptance. Restore
test-only rules, branch protection and backend processes when finished.
