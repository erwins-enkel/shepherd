# Blocked-Triage Queue — Design

> Status: approved 2026-05-30. Next: implementation plan (writing-plans).

## Problem

Shepherd ships the observation half of "one operator, many agents" — status lights,
live terminals, All-view, usage gauges. The act/triage half is missing. The `blocked`
status light is **passive**: it only works if you're staring at the screen, and when
several agents go red it gives no help deciding which to handle first. The operator is
still a bottleneck — a watching one.

This feature turns the passive red light into an actionable, prioritized work queue:
never miss a blocked agent, and resolve each in one tap.

## Constraints

- **ToS-clean.** Replies are typed into the real PTY exactly like a human, via
  `herdr.send(agentId, text + "\r")` — the same steering path already used. Nothing
  impersonates or drives Claude programmatically beyond typing.
- **Thin orchestrator.** No model dependency. Reason derivation is deterministic
  heuristics over terminal text. (Local-model summarization was considered and rejected
  as against the thin ethos.)
- **Never auto-reply, never guess "safe."** The tool surfaces and routes; the operator
  decides. No auto-approve.

## Existing substrate (reused, not rebuilt)

- `StatusPoller` (`src/poller.ts`) ticks every 1s, maps herdr state, fires
  `onChange(id, status)` on transitions — the classification hook.
- `HerdrDriver.read(agentId, "visible", lines)` (`src/herdr.ts`) returns terminal text.
- `HerdrDriver.send(target, text)` writes literal text to the PTY (no implicit Enter).
- `EventHub.emit(event, data)` (`src/events.ts`) broadcasts over the `/events` WS.
- REST under `/api/...` with auth + origin guards (`src/server.ts`).

## Design

### 1. Heuristic classifier (server)

Pure function `classifyBlocked(tail: string): BlockReason` in a new `src/blocked.ts`,
run on `herdr.read(agentId, "visible")` output.

Recognized shapes:

| Shape | Detection | Quick-replies offered |
| --- | --- | --- |
| `menu` | lines matching `^\s*❯?\s*\d+\.\s+…` (Claude permission/plan/trust prompts) | one button per captured option; button sends the digit |
| `yes-no` | trailing `(y/n)` / `[Y/n]` style prompt | **Yes** / **No** |
| `awaiting-input` | blocked but no menu/yes-no detected | free-text box only |

`BlockReason` always also carries `tail` = last ~15 non-empty lines, so the operator can
read context even when the shape is unclassified. The catalog lives in one file with a
test fixture table — easy to extend as Claude's prompts change. The classifier never
auto-replies and never marks an option "safe".

```
type BlockShape = "menu" | "yes-no" | "awaiting-input";
interface BlockOption { label: string; send: string; } // send = literal text typed (no \r)
interface BlockReason {
  shape: BlockShape;
  options: BlockOption[]; // empty for awaiting-input
  tail: string[];         // last ~15 non-empty terminal lines
}
```

### 2. Wiring (server)

- On poll `onChange` into `blocked`: read + classify once; cache `block` on the session.
- While still `blocked`, re-classify on a slow cadence (~every 3s) so menus that change
  get refreshed without hammering herdr. (Implemented in/around the poller; only blocked
  sessions incur reads.)
- New transient field on `Session`: `block?: BlockReason` (not persisted to store on disk;
  derived state). Emit `session:block` (and clear on resume) over the existing `/events`
  hub so the UI updates live.
- New endpoint `POST /api/sessions/:id/reply` with body `{ text: string }` →
  `herdr.send(agentId, text + "\r")`. Behind the same auth + origin guards. Reused by both
  single and batch replies.

### 3. Drawer (UI)

- Slim persistent badge in `TopBar`: **"Needs you · N"** where N = blocked count; red when
  N > 0. Present in every view, desktop + mobile.
- Click → drawer listing blocked agents, **oldest-blocked first** (longest wait = most
  stalled). Each row: desig + name, time-blocked, reason tail, and quick-reply buttons
  (for `menu`/`yes-no`) or a free-text box (`awaiting-input`).
- Replying posts to `/reply`; the row collapses out as the agent resumes (driven by the
  `session:block`-cleared / status event).

### 4. Batch

- Multi-select rows → "Reply to N" sends the **same literal text** to every selected agent
  (e.g. type `1` once to approve three identical permission prompts).
- Always explicit selection + a confirm step showing the exact text and the target list.
  No auto-select, no "approve all" magic.

### 5. Testing

- Unit: `classifyBlocked` against a fixture table of real captured Claude prompts
  (menu / yes-no / awaiting-input / garbage) → expected `BlockReason`.
- Unit: `POST /api/sessions/:id/reply` sends `text + "\r"` to the correct agent (mock
  runner); enforces auth/origin; 404 on unknown id.
- UI: drawer renders and sorts from a mock event stream; quick-reply and batch fire the
  correct POST(s).

## Out of scope (separate backlog items)

- `done`-review and Web Push notifications (backlog #1) — the drawer is **blocked-only**
  for now. The "Needs you" framing intentionally leaves room to fold `done` in later.
- Inline diff review (backlog #4).
- Saved steers / broadcast templates (backlog) — distinct from blocked-reply batching.

## Open questions

- None blocking. herdr `blocked` granularity assumed sufficient to distinguish
  needs-input from transient working states; validate against real captures when building
  the classifier fixtures.
