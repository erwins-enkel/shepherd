# Spike: can a mid-stack merge failure strand half a stack on the base branch?

**Date:** 2026-08-09 · **Issue:** #2060 (Step 1) · **Parent note:**
`docs/research/github-stacked-prs-2026-08-08.md` §5.2.1 (open PR #2049) · **Repo under test:**
`erwins-enkel/stack-atomicity-spike` (throwaway, archived after the run)

## Why

GitHub's own documentation contradicts itself on what happens when a stack merge fails partway:

- [Merging stacked pull requests](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-stacked-pull-requests):
  the selected PR and all unmerged PRs below it land on the base branch "together as a single
  operation."
- [Troubleshooting stacked pull requests](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-stacked-pull-requests):
  "Pull requests below it that merged successfully remain landed on the base branch. The failed pull
  request and the pull requests above it stay open."

The answer decides whether epic **shape (a)** — stack rooted at `main`, integration branch and landing
PR deleted — is legal. If a mid-stack failure can leave half an epic on `main`, that is precisely what
`resolveSpawnBase` (`src/drain.ts`) fails closed to prevent: "Never silently base an epic child on the
default branch … that child would land on main mid-epic."

## Verdict

**No partial landing was observed, in any leg.** Across two merge actions and two distinct failure
classes, a failing layer left the base branch completely untouched and every layer open — including
layers _below_ the failure that were independently mergeable.

The two doc pages describe **different failure classes**, and only one of them is reachable through the
API's validation phase:

| Failure class                                            | Observed                                            |
| -------------------------------------------------------- | --------------------------------------------------- |
| A layer fails its **required checks** (rules)            | Whole merge rejected, nothing lands                 |
| A layer fails at **merge time** (merge conflict)         | Whole merge rejected, nothing lands                 |
| A layer fails **after a lower layer has already landed** | Not forceable — see [Limits](#limits-of-this-spike) |

GitHub validates and stages the entire group before mutating the base branch. The troubleshooting
page's partial-landing scenario is an error path _after_ that point ("an unexpected conflict or an
**intermittent failure**") — a genuine but rare window this spike could not open on demand.

**Recommendation unchanged: shape (a) stays parked.** Not because a rule failure can strand a half-epic
— it demonstrably cannot — but because the residual window is undocumented, unbounded, and unfalsifiable
from outside GitHub, and shape (b) gets most of the drift reduction without betting the epic model on
it. The spike upgrades shape (a) from "unsafe" to "unproven", which is not the same as "cashable".

## Method

Nine PRs in three independent 3-layer stacks, so no leg had to undo another's state, plus a fourth
stack as a positive control.

- `main` carries a 20-line `shared.txt` and `.github/workflows/gate.yml` — a `pull_request` workflow
  publishing a check named `gate` that **fails when the head branch name ends in `-fail`**.
- Each layer edits one disjoint line of `shared.txt`, so layers do not conflict with each other.
- Stacks composed over REST — `POST /repos/{o}/{r}/stacks` with `pull_requests` bottom→top — never
  `gh stack`, which opens a full-screen TUI under a PTY and would wedge an unattended agent
  (parent note §2.5).

| Stack | PRs      | Branches            | Leg                                     |
| ----- | -------- | ------------------- | --------------------------------------- |
| 10    | 1, 2, 3  | `a1`/`a2-fail`/`a3` | A — rule failure, `direct_merge`        |
| 11    | 4, 5, 6  | `b1`/`b2-fail`/`b3` | B — rule failure, `merge_queue`         |
| 12    | 7, 8, 9  | `c1`/`c2`/`c3`      | C — merge-time conflict, `direct_merge` |
| 17    | 14,15,16 | `d1`/`d2`/`d3`      | D — positive control, all green         |

### The requirement has to bite the middle layer

A ruleset scoped to `main` would not have constrained the middle layer at all: it bases on the layer
below it, not on `main`. GitHub claims every layer is evaluated against the rules of the **stack base**
regardless of what it directly targets — but that claim is one of the things under test here, so it was
not made load-bearing. The ruleset therefore targets **all branches**:

```jsonc
{
  "name": "gate-all-branches",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [], // nothing can bypass the rule under test
  "conditions": { "ref_name": { "include": ["~ALL"] } },
  "rules": [
    {
      "type": "required_status_checks",
      "parameters": {
        "required_status_checks": [{ "context": "gate" }],
        "strict_required_status_checks_policy": false,
        "do_not_enforce_on_create": true,
      },
    },
  ],
}
```

It is created **after** every branch is pushed and every PR is open, or its own required check blocks
the setup pushes.

### Negative control

Every leg opens with a capture proving the middle layer is genuinely blocked. Without it, "the stack
refused to merge atomically" and "nothing was blocking it" produce identical evidence.

```
$ gh api repos/$R/rules/branches/a2-fail
[{"ctx":[{"context":"gate"}],"ruleset":20606201,"type":"required_status_checks"}]

$ gh api graphql … pullRequest(number:2){ mergeable mergeStateStatus }
{"baseRefName":"a1","headRefName":"a2-fail","mergeStateStatus":"BLOCKED","mergeable":"MERGEABLE","number":2}

$ gh api repos/$R/commits/a2-fail/check-runs
[{"conclusion":"failure","name":"gate","status":"completed"}]
$ gh api repos/$R/commits/a1/check-runs   → [{"conclusion":"success","name":"gate"}]
$ gh api repos/$R/commits/a3/check-runs   → [{"conclusion":"success","name":"gate"}]
```

`mergeable: MERGEABLE` with `mergeStateStatus: BLOCKED` is the exact state wanted: no conflict, blocked
purely by the rule. The neighbours are green, so the bottom layer is independently mergeable.

## Leg A — rule failure, `merge_action: direct_merge`

Pre-merge state: `pr#1 clean · pr#2 blocked · pr#3 clean`. Merge requested on the **top** PR (#3), which
by GitHub's semantics must carry #2 and #1 with it.

```
$ gh api --method PUT repos/$R/pulls/3/merge-async \
    -f merge_method=squash -f merge_action=direct_merge -f sha=$SHA
{"status":"pending","details":{"message":"Merge request enqueued.",
 "uuid":"317942bc-…","merge_method":"squash","merge_action":"direct_merge",
 "expected_head_sha":"66498529…"}}

poll1: {"status":"failed","details":{"message":"Required status check \"gate\" is failing."}}
```

**Outcome — nothing landed.**

```
main after : ["1bc5e29 chore: spike scaffold"]        # identical to main before
pr#1 a1 state=open merged=false mstate=clean          # ← independently mergeable, still open
pr#2 a2-fail state=open merged=false mstate=blocked
pr#3 a3 state=open merged=false mstate=clean
```

## Leg B — rule failure, `merge_action: merge_queue`

A second ruleset (`merge-queue-main`, `~DEFAULT_BRANCH`, `merge_queue` rule, `SQUASH`, no bypass actors)
was added for this leg only. Pre-merge state: `pr#4 clean · pr#5 blocked · pr#6 clean`, `gate` failing on
`b2-fail`.

First attempt was rejected on request shape, which is a finding in its own right:

```
$ gh api --method PUT repos/$R/pulls/6/merge-async \
    -f merge_method=squash -f merge_action=merge_queue -f sha=$SHA
{"message":"Custom merge params (merge_method, commit_title, commit_message) are not supported
  with the merge_queue merge action.", "status":"422"}
```

Retried without `merge_method`:

```
{"status":"pending","details":{"message":"Merge request enqueued.","uuid":"19c543eb-…",
 "merge_method":"default","merge_action":"merge_queue","expected_head_sha":"a9794d78…"}}

poll1: {"status":"failed","details":{"message":"Pull request has failing required statuses
        and Pull request Required status check \"gate\" is failing."}}
```

**Outcome — nothing landed, and nothing ever entered the merge queue.** (The `"Merge request enqueued."`
message in the `PUT` response refers to the async merge _request_, not to a merge-queue entry — the queue
itself stayed empty throughout.)

```
main after : ["1bc5e29 chore: spike scaffold"]
pr#4 b1 open merged=false clean · pr#5 b2-fail open merged=false blocked · pr#6 b3 open merged=false clean
mergeQueue(branch:"main"){entries} → {"entries":{"nodes":[]}}
```

The stack was rejected _before_ reaching the queue, so the queue's documented
"stacks are kept together … if a pull request is ejected, all pull requests above it are also ejected"
behaviour never came into play. Same all-or-nothing result as leg A, by an earlier gate.

### Teardown before leg C

The merge-queue ruleset was deleted and `main` re-read, so leg C's refusal could not be a
queue-requirement refusal wearing a conflict's clothes:

```
$ gh api --method DELETE repos/$R/rulesets/20606214
$ gh api repos/$R/rules/branches/main
[{"ruleset":20606201,"type":"required_status_checks"}]   # gate only
```

## Leg C — merge-time failure, `merge_action: direct_merge`

Setup: all three `c` layers green. A commit rewriting **line 10** — the exact line `c2` edits — was
landed on `main` through its own green PR (#13), and the stack was deliberately **not** restacked. `c1`
(line 2) and `c3` (line 18) do not conflict with it; only `c2` does.

GitHub does not pre-detect this. Every layer reports clean, because each is evaluated against the layer
below it, not against the moved trunk:

```
pr#7  c1->main    mergeable=true mstate=clean   stackpos=1/3
pr#8  c2->c1      mergeable=true mstate=clean   stackpos=2/3   ← conflicts with main, reported CLEAN
pr#9  c3->c2      mergeable=true mstate=clean   stackpos=3/3
graphql: p7 CLEAN · p8 CLEAN · p9 CLEAN
```

```
$ gh api --method PUT repos/$R/pulls/9/merge-async \
    -f merge_method=squash -f merge_action=direct_merge -f sha=$SHA
{"status":"pending","details":{"…","uuid":"82d87116-…","merge_action":"direct_merge"}}

poll1: {"status":"failed","details":{"message":"Merge conflict detected"}}
```

**Outcome — nothing landed.** This is the decisive leg: the failure is a genuine _merge-time_ conflict,
not a rule violation, and the bottom layer was green and cleanly mergeable into `main` on its own. It
still did not land. (`c1` was _behind_ the moved trunk, not current with it —
`strict_required_status_checks_policy` is `false`, so being behind is not itself a block, and its
`mergeable: true` says the merge would have applied without conflict.)

```
main after : ["97fd3fb fix: rewrite line 10 on main to conflict with c2 (#13)", "1bc5e29 chore: spike scaffold"]
pr#7 c1 open merged=false mergeable=true clean   ← would have merged on its own; did not
pr#8 c2 open merged=false · pr#9 c3 open merged=false
stack 12: open=true, prs all open
```

The refusal reason is recorded verbatim (`"Merge conflict detected"`) and is distinct from both a
restack refusal and a queue-requirement refusal.

## Leg D — positive control

Legs A–C all report "nothing landed", so the harness itself has to be shown capable of landing
something. A fresh, fully green 3-layer stack (`d1`/`d2`/`d3`, stack 17) off the same `main`, under the
same ruleset, same call shape:

```
poll1: {"status":"pending","details":{"message":"Merge request is in progress.", …}}
poll3: {"status":"merged","details":{"message":"Pull request was merged.","sha":"8b7b71d8…"}}

main after:
  8b7b71d feat: d3 touches line 19 (#16)
  33e1bca feat: d2 touches line 12 (#15)
  b0ab3d1 feat: d1 touches line 3 (#14)
  97fd3fb fix: rewrite line 10 on main to conflict with c2 (#13)
pr#14 merged=true · pr#15 merged=true · pr#16 merged=true
```

One squash commit **per layer**, bottom→top, from a single merge call on the top PR — confirming the
parent note's §5.2.1 claim that stack squash-merge restores per-child granularity that a single squashed
landing PR destroys.

## Secondary findings

### 1. `merge_method` + a required merge queue is a live defect in our merge path

`putMergeAsync` (`src/forge/github.ts`, shipped in #2061) **always** sends `merge_method` and **never**
sends `merge_action`. Under a branch that requires a merge queue, that combination is accepted and then
fails asynchronously:

```
$ gh api --method PUT repos/$R/pulls/6/merge-async -f merge_method=squash -f sha=$SHA
{"status":"pending","details":{"…","merge_method":"squash","merge_action":"default", …}}

poll1: {"status":"failed","details":{"message":"Custom merge params are not supported
        when merging via a merge queue"}}
```

Note the shape of the failure: the `PUT` succeeds, so nothing is caught at request time; the poll
returns `status: "failed"`, which `mergeAsyncSettled` converts into a generic `Error`. An operator
merging a stacked PR on a merge-queue repo therefore sees
`merge of #N failed: Custom merge params are not supported when merging via a merge queue` — a message
about request parameters, for a merge they had no way to shape. An explicit `merge_action=merge_queue`
would at least have failed loudly at request time with a `422`.

Shepherd's own repo does not require a merge queue, so this is latent here and live for any consumer
repo that does. Filed as a follow-up.

### 2. `409` adopt-existing-uuid confirmed against the live API

A second `PUT` while a merge request is in flight returns `409` with the **original** request's uuid in
the body — exactly what `putMergeAsync`'s 409 branch adopts:

```
{"status":"pending","details":{"message":"A merge request already exists for this pull request.",
 "uuid":"fc3160de-…"}}   HTTP 409     # same uuid as the in-flight request
```

### 3. The top layer's own state does not reveal that the stack is unmergeable

In legs A and B the top PR reported `mergeable_state: clean` while a layer beneath it was `blocked`. Any
gate that reads only the PR it is about to merge — the Backlog Merge button, `AutoMergeService` — will
see a green PR and a merge that then fails. Stack-mergeability must be derived from the whole stack, not
from the selected PR.

### 4. A conflict against the trunk is invisible until merge time

Leg C's `c2` reported `CLEAN`/`MERGEABLE` right up to the merge attempt. Layers are diffed against the
layer below, so a stack that has fallen behind its trunk looks perfectly healthy. Anything that decides
"this stack is ready" from per-PR mergeability will be wrong whenever the trunk has moved.

### 5. A `~ALL` ruleset blocks the restack force-push

Rebasing a layer branch onto a moved trunk and force-pushing it is refused while the ruleset requires a
check on all branches:

```
remote: error: GH013: Repository rule violations found for refs/heads/c1.
 ! [remote rejected] c1probe -> c1 (push declined due to repository rule violations)
```

Branch _creation_ was exempt (`do_not_enforce_on_create: true`); _updates_ are not. Any repo that puts
required checks on all branches makes the local `gh stack rebase` + push restack path unusable, leaving
only the server-side UI button — whose commits are unsigned (parent note §2.6). Worth knowing before
recommending a ruleset shape alongside stacks.

### 6. Layer branches linger after a stack merge

After leg D merged all three layers, `d1`, `d2` and `d3` still existed on the remote. `merge-async` takes
no delete-branch parameter, which confirms the reasoning already written into `mergeStacked`'s doc
comment. Nothing reaps them — `BranchPruner` only sweeps local `shepherd/*` branches.

## Limits of this spike

- **The documented partial case was not reproduced, and could not be forced.** Both failure classes
  reachable from outside GitHub are caught during validation, before the base branch is touched. The
  troubleshooting page's scenario requires a failure _after_ the first layer's ref update has committed —
  GitHub offers no lever for that, and "an intermittent failure" is by definition not on demand. Absence
  of evidence here is weak evidence of absence: it bounds the risk to a rare post-commit window rather
  than eliminating it.
- **Merge queue was tested only to the point of rejection.** The stack never entered the queue, so
  ejection semantics for a queued stack remain untested.
- **One repo, one day, one preview feature.** Every stacked-PR docs page says "public preview and
  subject to change". Re-run before relying on this.

## Reproducing

```bash
R=<owner>/<throwaway-repo>
# 1. main: README + .github/workflows/gate.yml (check `gate`, exit 1 when head branch ends in -fail)
#    + a 20-line shared.txt
# 2. push layer branches (each edits a disjoint line), open PRs bottom→top
# 3. compose the stack — REST only, never `gh stack` under a PTY:
gh api --method POST repos/$R/stacks -F 'pull_requests[]=1' -F 'pull_requests[]=2' -F 'pull_requests[]=3'
# 4. ruleset LAST (see the JSON above), or its own required check blocks the setup pushes
# 5. negative control, every leg:
gh api repos/$R/rules/branches/<mid-branch>
gh api repos/$R/commits/<mid-branch>/check-runs
gh api graphql -f query='…pullRequest(number:<mid>){mergeable mergeStateStatus}'
# 6. merge the TOP pr; poll to terminal:
SHA=$(gh api repos/$R/pulls/<top> --jq .head.sha)
gh api --method PUT repos/$R/pulls/<top>/merge-async \
  -f merge_method=squash -f merge_action=direct_merge -f "sha=$SHA"
gh api repos/$R/pulls/<top>/merge-async/<uuid>
# 7. the only answer that counts:
gh api "repos/$R/commits?sha=main"
```

## Consequences for #2060

- **Step 2 (shape (b) — stack children onto the integration branch) is unaffected and proceeds.** It
  never depended on this answer.
- **Shape (a) stays out of scope.** The specific fear — a rule failure stranding a half-epic on `main` —
  is disproven. The remaining blockers from the parent note §7 are untouched: the DAG/chain mismatch, a
  mid-stack close wedging every layer above it with no reorder API, and preview churn. Finding 5 adds
  one more: a repo with all-branch required checks cannot restack over the CLI at all.
- **Findings 3 and 4 are design input for Step 2.** Whatever decides "this stack is ready to land" must
  read the whole stack and must not trust per-PR mergeability once the trunk has moved.
- **Finding 1 is a defect to fix independently of the epic work.**
