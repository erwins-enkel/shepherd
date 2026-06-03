# Autopilot Mode — Design

> Status: approved 2026-06-03. Next: implementation plan (writing-plans).

## Problem

Shepherd makes a _fixed-quality_ agent easier to supervise — it routes attention, reviews
output, and lets you steer in-flight. But the agent still **stops constantly**, and most of
those stops aren't real decisions. An interactive Claude Code agent pauses to ask "should I
write a spec first or start implementing?", "ready for me to begin?", "want me to commit
now?" — procedural ceremony, not product judgement. Each pause parks the session on the
"needs you" pile and burns an O(N) slice of operator attention to clear with a one-word
"yes". The operator becomes a clicker of "proceed" buttons.

The genuinely-needs-you moments — a real requirements fork, an ambiguous product call — are
_buried_ in that same pile, indistinguishable from the ceremony until you read the tail.

Autopilot separates the two. It keeps a session moving through procedural gates on its own
and drives it toward a PR, while escalating the _real_ questions to you **louder** than
today (distinct state + push). You step away; it only pings you when it actually needs a
human decision; you come back to a PR.

The post-PR phase is already automated (the critic's `runAutoAddress` loop). Autopilot is
its **pre-PR twin** — same shape, earlier in the lifecycle.

## Constraints

- **Opt-in, spendy-loop-OFF by default.** Autopilot is a per-classify LLM spawn loop. Per
  the repo house rule, it defaults **OFF** and requires explicit opt-in (`autopilotEnabled`,
  next to `criticEnabled`/`autoAddressEnabled`). A per-session toggle is the live kill switch.
- **ToS-clean / subscription-spawn only.** The classifier is a transient _interactive_
  `claude` spawn (the namer/critic pattern), never `claude -p`, never a local model. It runs
  read-only: `--permission-mode dontAsk` with a scoped `--allowedTools` allowlist, **never**
  `--dangerously-skip-permissions`. It ingests untrusted agent output, so it must not mutate
  anything outside its own scratch space.
- **Shepherd owns the pane text, not the LLM.** The classifier only _classifies_ (returns a
  kind + a short summary). The text typed back into the agent's pane is a **server-owned
  English template** — the LLM never authors pane input. Keeps injected content bounded and
  out of an untrusted model's hands.
- **Tool authority is never delegated.** Autopilot steers _conversational_ gates only. It
  **never** auto-answers Claude Code tool-permission menus ("1. Yes  2. Yes, don't ask
  again  3. No") — auto-clicking those equals `--dangerously-skip-permissions`. Permission
  prompts always surface as needs-you, exactly as today.
- **Bias toward surfacing.** When classification is uncertain, treat it as a question and
  stop. A wrongly-surfaced gate costs one operator click; a wrongly-auto-answered question
  costs a bad product decision. False negatives are cheap; false positives are not.
- **Bounded per tick.** At most one classify spawn per settled session per block episode,
  cached by tail-hash — respects the poller-load house rule (no unbounded fan-out per tick).
- **Spawn gotchas (already burned us).** Bare `Write` tool (scoped `Write(path)` denied under
  `dontAsk`); prompt before a variadic `--allowedTools`; `--settings disableAllHooks` not
  `--bare` so sub-OAuth keeps working. Haiku model.

## Existing substrate (reused, not rebuilt)

- `StatusPoller` (`src/poller.ts`) — already detects block/idle/done every 1s and emits
  `session:block` with a `classifyBlocked` shape. Autopilot subscribes; it does not re-poll.
- `classifyBlocked` (`src/blocked.ts`) — tells us _that_ an agent is waiting and the shape
  (menu / yes-no / awaiting-input / stall). Autopilot adds the missing **semantic** layer
  (_what_ it's waiting for) only when needed.
- `SessionService.reply` (`src/service.ts:364`) — bracketed-paste steering into a live pane;
  liveness-checks and returns `false` for a dead pane. Autopilot steers through this.
- `SessionService.resume` — `claude --resume` for an exited pane; needed for `finished`-but-
  dead sessions.
- `ReviewService.runAutoAddress` (`src/review.ts:412`) — the post-PR auto-steer loop:
  per-repo gated, capped, escalates at the cap. Autopilot is the structural twin; the loop
  hands off to it once a PR opens.
- Transient-claude spawn plumbing (`src/namer-llm.ts`, `src/distiller.ts`, `src/review.ts`) —
  temp scratch dir, JSON-file verdict, poll-with-timeout, reap. The classifier clones this.
- `RepoConfig` + `repo_config` table (`src/store.ts:25`) — per-repo toggles + auto-migration.
- `PushNotification` — the loud hand-back channel.

## Architecture — a dedicated `AutopilotService`

A new `src/autopilot.ts` service, wired in `index.ts` next to `ReviewService`. A separate
service (vs. folding into `StatusPoller` or `ReviewService`) keeps the pre-PR loop isolated
and independently testable; `ReviewService` already owns the _post_-PR loop.

```
StatusPoller --(session:block / idle / done)--> AutopilotService.consider(session, blockReason)
                                                       |
                                  enabled? no open PR? settled? not already paused?
                                                       | yes
                                              classify (transient claude, haiku)
                                                       |
                  +------------------+------------------+------------------+
                  | gate             | finished         | question/unknown | menu shape
                  v                  v                  v                  v
        steer "proceed" tmpl  steer "open a PR"   pause + summary +   surface as needs-you
        step++                (resume if dead)    PushNotification    (no spawn, no answer)
                  |                  |                  |
                  +-> step >= cap? --+--> pause + surface + push (runaway guard)
                  |
        PR opens at any point -> hand off to ReviewService, autopilot done
```

### Trigger / debounce

- Acts on a session that is **settled** (block persisted across one classify cycle, or
  idle/done), **autopilot-enabled**, with **no open PR**, and **not already autopilot-paused**.
- One classification per block **episode**, keyed by a hash of the terminal tail. If the tail
  is unchanged, no re-spawn. A new episode (tail changed / block cleared and re-armed) re-arms,
  mirroring the stall once-per-episode guard.

## The classifier

Transient `claude` spawn over a scratch dir containing the terminal tail + the session's task
prompt. Argv shape (namer/critic pattern):

```
claude --session-id <uuid> --settings '{"disableAllHooks":true}'
       --disable-slash-commands --allowedTools Read Write
       --permission-mode dontAsk --model haiku <prompt>
```

Prompt asks it to read the tail and write a JSON verdict file:

```jsonc
{
  "kind": "gate" | "question" | "finished" | "unknown",
  "summary": "1–2 sentence plain-English description of what the agent is waiting for"
}
```

- `gate` — a procedural/workflow stop the agent could resolve itself ("shall I write the
  spec?", "ready to start?", "commit now?"). Only when the answer is obviously "yes, keep going".
- `question` — a real decision needing the human (product/requirements fork, ambiguous intent,
  anything the agent shouldn't unilaterally decide).
- `finished` — the agent believes it's done / has nothing queued, but no PR exists yet.
- `unknown` — can't tell. Treated as `question` (bias-to-surface).

Polled from the verdict file (15s interval, 10m timeout, like the critic). A timeout / unusable
verdict is treated as `unknown` → surface. The summary is **never** typed into the agent's pane;
it only feeds the operator-facing paused state.

## Actions

Pane text is a fixed **server-owned English template** (agent-facing → not in the i18n catalog):

- `gate` → steer the **proceed** template, roughly: _"You're in autopilot. Don't stop to ask
  whether to write specs or begin implementing — make a reasonable call and keep going until a
  PR is open. Only stop for a genuine product/requirements decision the user must make."_
  Then `autopilotStepCount++`.
- `finished` → steer the **open-a-PR** template: _"You've stopped but there's no PR yet. Commit
  your work, push the branch, and open a PR. If something blocks that, say what."_ If the pane
  has exited, `resume` first, then steer. `autopilotStepCount++`.
- `question` / `unknown` → **pause** (below). No steer.

### Shape gating (which blocks even reach the classifier)

`classifyBlocked` shape decides eligibility _before_ any spawn:

- `awaiting-input` (free text) and `yes-no` → eligible; classify and act per verdict. These are
  where the cheap procedural gates live ("shall I…? (y/n)", "ready to start?").
- `menu` → **always surfaced, never auto-answered, no spawn.** A numbered menu is either a
  Claude Code tool-permission prompt (auto-clicking = `--dangerously-skip-permissions`) or the
  agent offering the operator a real choice — both are needs-you. Bias-to-surface makes the
  ambiguous case safe by construction, so menus don't need semantic classification at all.
- `stall` → not a question; existing stall escalation owns it. Autopilot ignores stalls.

A steer that doesn't land (dead/unreachable pane, `reply` → `false`) does **not** advance the
step count — same no-progress rule as `runAutoAddress`.

## Surfacing genuine questions (the loud hand-back)

- New per-session fields: `autopilotPaused: boolean` and `autopilotQuestion: string | null`
  (the classifier summary). Rendered as a distinct **"Autopilot paused — needs you"** state on
  the board, separate from the generic red "needs you" badge — the operator sees _autopilot_
  specifically handed this back.
- Fires a `PushNotification` with the summarized question so a stepped-away operator gets pinged.
- When the operator replies (`SessionService.reply`), `autopilotPaused` clears and the loop
  re-arms on the next settled state.
- New UI strings (state label, paused tooltip, toggle label) added to **both** `en.json` and
  `de.json`. Agent-facing steer templates stay English-only (commented why).

## Opt-in & configuration

- `RepoConfig.autopilotEnabled: boolean` — default **OFF**. Added to the `repo_config` table
  with the existing auto-migration (older DBs get the column defaulted false). Surfaced in the
  repo settings UI beside the critic / auto-address toggles.
- `Session.autopilotEnabled: boolean | null` — per-session override; `null` inherits the repo
  default. A live toggle on the session = the **kill switch** (flip off → loop stops at once).
- `autopilotStepCap` — global setting (`config.ts`), default ~10.
- Autopilot and the critic/auto-address loop are **independent** toggles. Enable both for fully
  hands-off (autopilot drives to the PR, critic + auto-address drive it green).

## Safety bounds

- `Session.autopilotStepCount` — incremented per landed auto-steer. At `>= autopilotStepCap`,
  autopilot **pauses + surfaces + pushes** even when the stop wasn't a genuine question — a
  runaway guard mirroring the critic's 3-round cap. Reset when a PR opens (handoff) or the
  operator manually intervenes.
- Per-session kill switch (override toggle → off).
- One classify spawn per settled session per episode; tail-hash cache prevents re-spawn churn.
- Permission menus never auto-answered. Tool authority stays with the session's permission mode.

## Out of scope (this iteration)

- Auto-approving tool-permission prompts.
- Driving the post-PR phase (owned by the critic / `runAutoAddress`).
- Multi-PR or per-issue step accounting — one step budget per session is enough for the prototype.
- Choosing _which_ approach the agent takes on a real fork — that's a `question`, surfaced to you.

## Testing

- Shape gating: `menu`/`stall` never spawn the classifier; only `awaiting-input`/`yes-no` do.
- Classifier verdict parsing: each `kind`, plus malformed/timeout → `unknown` → surface.
- Loop transitions: gate → steer + step++; finished-dead → resume + steer; question → pause +
  push; step >= cap → pause; PR opens → handoff (no further steers).
- No-progress rule: steer to a dead pane doesn't advance the step count.
- Episode guard: unchanged tail → no second spawn; changed tail → re-arm.
- Config: repo default OFF; session override inherit/on/off; live toggle-off stops the loop.
- i18n parity: new EN keys have DE counterparts (the `check:i18n` gate).

## Open questions

- None blocking. Step-cap default (~10) and classifier model (haiku) are tunable post-prototype.
