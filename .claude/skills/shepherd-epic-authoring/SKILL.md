---
name: shepherd-epic-authoring
description: Author a Shepherd-recognized epic in an attended session — decompose work into child issues, create them, mark the parent body with the structural epic marker (fenced dag / task-list), and hand the optional native sub-issue + blocked_by link import to the operator. Use when asked to create an epic with sub-issues, promote an existing issue #N to an epic, split an issue into child issues, or make a body of work drainable as an epic — especially mid-session, where no injected epic guidance exists.
---

# Shepherd Epic Authoring

Turn an **attended** epic ask into structure Shepherd actually recognizes. Two
flows share the same spine:

- **Create** — "create an epic for X with sub-issues Y, Z".
- **Promote** — "promote existing issue #N to an epic".

Shepherd's spawn-time prompts already carry a short epic-shape contract, but that
detection is **spawn-time only**: an operator who asks for an epic **mid-session
(steer-time)** gets no injected epic guidance at all — the agent falls back on
generic GitHub habits and ships an "epic" Shepherd never sees. This skill is the
remedy for exactly that gap: invoke it whenever an epic ask arises, at spawn or
mid-session.

This skill is **self-contained**: it ships in the Shepherd repo and runs in
_other_ operators' repos. Everything it needs is in this file and its
`references/`.

## The recognition contract

Shepherd recognizes an epic **ONLY structurally** — the parent issue's body
must reference each child's **REAL issue number**, via **either** marker:

1. A fenced dag block. One `#<n>` line per child; `#<n> <- #<m>` when `#n` is
   blocked by `#m` (multiple blockers comma-separated). The canonical example:

   ````
   ```epic-dag
   #12
   #13 <- #12
   #14 <- #12, #13
   ```
   ````

2. A task-list — one `- [ ] #12`-style line per child issue (members only, no
   dependency edges).

The body marker is **MANDATORY even when the children have no dependencies**.
Only the **first** fenced dag block in a body is parsed — keep exactly one.

**NOT recognized:** an `epic` label, an `[EPIC]` title prefix, a prose
checklist without `#<n>` issue references, front-matter, or HTML markers. None
of these exist in Shepherd's parser — don't reach for them.

## Stages

Work the stages in order; track one todo per stage. **Nothing outward (issue
creation, body edits) happens before the Stage 2 approval gate.**

| Stage                      | What happens                                                       | Detail                   |
| -------------------------- | ------------------------------------------------------------------ | ------------------------ |
| 0. Orient                  | Pin the flow (create vs promote) and the tracker (GitHub vs local) | `references/drafting.md` |
| 1. Draft                   | Decompose into tracer-bullet vertical slices; draft the whole tree | `references/drafting.md` |
| 2. Approve (hard gate)     | Present the full draft, then **stop** for `AskUserQuestion`        | `references/creating.md` |
| 3. Create (ordered)        | Children first (capture numbers), then mark the parent body        | `references/creating.md` |
| 4. Hand import to operator | Below — you cannot run it yourself                                 | this file                |
| 5. Verify + hand off       | Confirm the marker landed; name the DAG roots; open **no** PR      | `references/creating.md` |

**Read `references/drafting.md` before Stage 0** — it also covers the
Shepherd-driven draft-only mode, which changes which stages you run at all.

## Stage 4 — Hand import to the operator (GitHub-native only)

**You are already done with the epic.** The body marker **is** the recognition
contract — with it in place the epic is recognized and drainable. Import is a
separate, optional step that additionally wires **native sub-issue +
`blocked_by` links**; it is not automatic, and **you cannot trigger it**.

**Do not call the import endpoint.** You reach the Shepherd server only through
its restricted loopback ingress, which admits a short session-scoped allowlist
(hooks, build queue, epic draft). The import route is repo-scoped, not
session-scoped, so it is not on that allowlist — calling the main port instead
lands on the operator auth gate and returns `{"error":"unauthorized"}` (401).
That boundary is deliberate: import performs GitHub writes, which Shepherd keeps
on the operator's side of the gate. **Never go looking for the operator password
or an API token to get around it** — a 401 here is the system working.

Instead, tell the operator import is pending and give them both paths:

1. **In the UI (one click, always available).** Open the Backlog, expand the
   parent issue's row, and press **Import structure** — the button appears on
   the epic panel for a marker-derived epic. The same action is offered as a
   remediation inside that panel's **Diagnose** modal.
2. **From their own shell**, if they'd rather. OPERATOR-RUN — this needs the
   operator's credentials, so print it for them, do not run it:

   ```bash
   curl -s -X POST -G "http://127.0.0.1:7330/api/epic/import" \
     -H "Authorization: Bearer $SHEPHERD_TOKEN" \
     --data-urlencode "repo=$(git rev-parse --show-toplevel)" \
     --data-urlencode "parent=<PARENT_NUM>"
   ```

   Use your Shepherd server's host/port; `7330` is the default. The bearer
   header only works if `SHEPHERD_TOKEN` is configured on that server — it is
   optional and unset by default; without it, use the UI. The
   `-G`/`--data-urlencode` form keeps the POST while URL-encoding the query, so
   a repo path containing a space or `&` can't break the request.

The response reports `subIssuesAdded` / `dependenciesAdded` / `unresolved`. Tell
the operator that any `unresolved` member numbers usually mean a typo'd or
foreign issue reference in the parent body — worth reporting back so the body can
be fixed and import re-run.

## Gate rules (reference)

- **Outward actions are gated** on the Stage 2 approval — drafting is always
  safe; creating and editing are not.
- **GitHub-only operations:** `gh issue create` / `gh issue edit` require a
  GitHub-native forge; local/lightweight repos get the markdown fallback.
- **Import is the operator's, never yours:** it is off the agent ingress
  allowlist and 401s for you (Stage 4). Hand it over — never hunt for
  credentials to force it through.
- **Marker grammar:** members are `#<n>` lines inside the fenced dag block; an
  edge is `#<dependent> <- #<blocker>[, #<blocker>…]`; the task-list variant
  lists members only. Real numbers, one fence, marker mandatory.
- **No PR:** when the ask is to author or promote an epic, stop once the
  parent body carries the marker and import has been handed to the operator.
