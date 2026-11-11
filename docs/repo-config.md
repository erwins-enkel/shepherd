# Shared repository rules

Shepherd reads repository rules from `.shepherd/config.json` on the default branch of
`origin`. A successful rule edit through `PUT /api/repo-config?repo=<path>` creates one
`chore(shepherd): set repo rules` commit and pushes it directly to that branch. The
checked-out branch, working tree and index are untouched.

```json
{
  "criticEnabled": true,
  "autoDrainEnabled": false,
  "defaultModel": "inherit",
  "defaultEffort": "inherit"
}
```

## Fields and precedence

The shared fields are `criticEnabled`, `criticAllPrs`, `criticSmellLensEnabled`,
`autoAddressEnabled`, `autopilotEnabled`, `planGateEnabled`, `autoDrainEnabled`,
`autoMergeEnabled`, `buildQueueEnabled`, `draftMode`, `signoffAuthority`,
`manualStepsIssueEnabled`, `preWarmEpicLandingCi`, `epicStacksEnabled`, `autoLabel`,
`defaultModel` and `defaultEffort`.

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
ineffective, preserving the previous database behavior. Existing database rules are retained
as a fallback. With no `origin`, or in lightweight mode, all settings remain local and no
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
- `repoConfigCommit`: the full selected default-branch commit SHA, or `null` when no valid
  file is active (missing, invalid or disabled).

The first explicit shared-rule write seeds a complete file from the machine's current
rules, then applies the edit. Further edits merge into freshly fetched rules. Shared-rule
edits retain the draft/auto-merge and critic/signoff validation rules. A request containing
only machine fields never creates a commit or initializes a file.

For a mixed request, the machine fields and automation confirmation are saved only after
the rule push succeeds. A failed fetch or push returns HTTP 502 with
`code: "repo_config_write_failed"`; local changes are not applied. Check origin access or
branch protection before retrying. Concurrent remote edits may cause a non-fast-forward
refusal; Shepherd never force-pushes these settings. Protected-branch PR fallback is not
provided here. Remote Git and local SQLite do not form a distributed transaction across
process crashes or storage failures.
