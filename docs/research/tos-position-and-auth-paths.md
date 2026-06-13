# ToS position & auth paths: resolving audit R1

**Summary.** Shepherd's interactive-keystroke-puppeting model is a _position_, not an Anthropic-confirmed clearance. This doc states that position honestly, evaluates the three auth footings an operator can choose (subscription puppeting / commercial API key / metered Agent SDK credit) even-handedly, sketches an API-key mode for the risk-averse, and drafts the question to put to Anthropic. It is the action surface for [audit](./claude-anthropic-tos-compliance-audit.md) recommendations 1 & 2.

> **Not legal advice.** Engineering/compliance reasoning by an AI agent against published Anthropic policy as of **2026-06-13**. The policy surface is _actively shifting_ (the decisive facts are days old and forward-looking — the Agent SDK metering takes effect **2026-06-15**). Treat this as a risk map to take to Anthropic and/or counsel, not a clearance.

Companion to the full [Terms-of-Service compliance audit](./claude-anthropic-tos-compliance-audit.md) (read it for the codebase map, the verbatim source quotes, and the complete risk register R1–R7).

---

## 1. Shepherd's position on R1

Shepherd does automated, largely-unattended work by _puppeting interactive_ Claude Code sessions — typing keystrokes into a real `claude` PTY via `herdr` — and thereby draws on the larger _interactive_ subscription allowance rather than the metered _Agent SDK_ channel Anthropic designates for automated subscription use (separate Agent SDK credit, effective 2026-06-15).

**The position (a good-faith reading, NOT Anthropic-confirmed):** "we type like a human into the official, unmodified CLI, so this is permitted interactive use." This is the load-bearing legal theory the PRD historically asserted as settled fact. The audit's central finding is a _negative_: **no primary Anthropic clause resolves whether keystroke-puppeting of interactive sessions for automated work is permitted.** The Consumer Terms §3 ban automated access "through a bot, script, or otherwise" except via an API key or "where we otherwise explicitly permit it" — and the _only_ explicit automation carve-out is the (now-metered) headless `claude setup-token` / `CLAUDE_CODE_OAUTH_TOKEN` path, not keystroke-puppeting of interactive panes.

> Consumer Terms §3 (verbatim): _"Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, … access the Services through automated or non-human means, whether through a bot, script, or otherwise."_ — <https://www.anthropic.com/legal/terms>

So Shepherd is a _third thing_ the published terms don't directly address: neither the sanctioned headless mode nor a literal human at a keyboard. The "we type like a human" framing is a behavioural argument, not a textual carve-out — and the existence of a metered Agent SDK credit for automated subscription use is a strong signal that automated work is _intended_ to flow through (and be capped by) that channel, which makes interactive-puppeting fairly characterisable as circumventing that metering.

**What would change the verdict:** an explicit Anthropic statement (support/policy answer, ToS clause, or Claude Code docs note) that either (a) blesses keystroke-driven automation of interactive sessions on a subscription, or (b) confirms automated/unattended usage must flow through the Agent SDK credit. See §5 for the drafted question. Until answered, treat the model as **at-risk, not blessed.**

---

## 2. The three footings (even-handed)

An operator can stand on any of three auth footings. None is pre-dismissed; each trades legal risk against allowance and cost.

### (A) Status-quo — subscription OAuth + interactive puppeting (current default)

- **Auth:** operator's own Claude Pro/Max subscription OAuth (`~/.claude/.credentials.json`); official unmodified Claude Code CLI; no API key, no token relay.
- **Allowance:** the **largest** — the full interactive subscription limit, shared across all spawns.
- **Legal risk:** **R1 ambiguity** — no explicit Anthropic blessing for automated keystroke-puppeting; the strongest reading is that it circumvents the Agent SDK metering (see §1).
- **Data risk:** training-by-default exposure (audit R5) — consumer/subscription inputs _can_ route into model training depending on the account's model-improvement setting, unlike the no-train-by-default Commercial/API path.

### (B) Commercial / API key (`ANTHROPIC_API_KEY`)

- **Auth:** an Anthropic API key. This moves the operator under the **Commercial Terms of Service**, not the Consumer Terms.
- **Legal risk:** **lowest on the automation clause** — the §3 automation prohibition explicitly _does not apply_ when "accessing our Services via an Anthropic API Key." The bot/script ban simply does not bite. (Per Consumer Terms: _"Our Commercial Terms … govern your use of any Anthropic API key …"_ — <https://www.anthropic.com/legal/terms>; corroborated by <https://code.claude.com/docs/en/legal-and-compliance>.)
- **Data risk:** **no train-by-default** — the Commercial/API path is no-train-by-default (audit R5), so this also closes the training exposure.
- **Cost:** metered API list rates (no subscription allowance; you pay per token).
- **Architectural cost — real, not a flag flip:** `src/reviewer-argv.ts` _deliberately refuses_ `--bare` / API-key auth today (it is subscription-OAuth-only by design — the spawn carries an explicit comment that `--bare` would force `ANTHROPIC_API_KEY` and break subscription OAuth). Adopting (B) is a genuine architectural change across the spawn path, not a toggle. See the §4 sketch.

### (C) Metered Agent SDK credit (`claude -p` / Agent SDK + `CLAUDE_CODE_OAUTH_TOKEN`, effective 2026-06-15)

- **Auth:** a long-lived OAuth token (`claude setup-token`) on a subscription, driving headless `claude -p` / the Agent SDK.
- **Legal risk:** **lowest of the three on R1** — this is the **only explicitly-permitted** subscription-automation channel per Anthropic's own docs. _"For CI pipelines, scripts, or other environments where interactive browser login isn't available, generate a one-year OAuth token with `claude setup-token`."_ — <https://code.claude.com/docs/en/authentication>.
- **Cost / trade-off:** a **separate, capped, metered** monthly Agent SDK credit, distinct from interactive limits. _"Starting June 15, 2026, Agent SDK and `claude -p` usage on subscription plans will draw from a new monthly Agent SDK credit, separate from your interactive usage limits."_ — <https://code.claude.com/docs/en/authentication>. Credit sizes Pro $20 / Max 5× $100 / Max 20× $200, billed at API list rates, opt-in, stops when exhausted — <https://support.claude.com/en/articles/15036540>.
- **Thesis tension (state it plainly):** adopting (C) would **reopen PRD §2's non-goal** — originally the absolute _"No Agent SDK, no `claude -p`. Ever, on a sub."_, now softened by this work to a _by-default_ position that cross-refs this doc — and the whole interactive-substrate thesis the product is built on. This is a tension to **weigh**, not a reason to dismiss (C): (C) is simultaneously the lowest-R1-risk automation path _and_ a direct contradiction of the founding non-goal.

---

## 3. Recommendation

Recommend, do **not** mandate — the operator chooses their footing:

- **Keep (A) as the default**, now wearing the honest, softened framing (R1 is Shepherd's _position_, not settled compliance — the PRD/PRODUCT softening lands this).
- **Offer (B) as a first-class, clearly-compliant opt-in** for risk-averse operators who cannot accept R1's ambiguity. The Commercial/API path sidesteps the automation clause entirely and closes the training-by-default exposure; its cost is metered API rates and the architectural change in §4.
- **Record (C) as the lowest-legal-risk, explicitly-permitted automation channel**, whose adoption is a deliberate **product decision** because it reopens the interactive-substrate thesis (§2(C)). Not recommended as default, but honestly the strongest R1 footing.

**Internal-consistency flag.** Surfacing (B)/(C) revisits **PRD §2's non-goal**, whose original wording was the absolute _"No Agent SDK, no `claude -p`. Ever, on a sub."_ This work has softened that line from the absolute non-goal to a _by-default_ position that cross-refs this doc, so the two stay consistent; this doc names the tension plainly so neither ships a contradictory stance. If (C) is ever adopted, the §2 non-goal must be rewritten further, not silently left standing.

---

## 4. Design sketch for (B) — API-key mode

> **NOT IMPLEMENTED — sketch for a future issue.** ADR-style outline only. No code in this PR.

**Shape.** An `authMode` setting: `subscription` (default, footing A) | `api-key` (footing B).

- Under `api-key`, spawns pass `ANTHROPIC_API_KEY` (and may then use `--bare`) instead of relying on subscription OAuth.
- The deliberate `NOT --bare` choices become **mode-conditional** at every spawn chokepoint:
  - `src/reviewer-argv.ts` — the critic/plan-gate reviewer argv (currently refuses `--bare` by design).
  - `src/namer-llm.ts` — the auto-namer spawn.
  - `src/autopilot-llm.ts` — the autopilot stop-classifier spawn.
- The autonomous **egress allowlist** (`src/egress.ts`, PR #601) is **unaffected** — `api.anthropic.com` is already on the allowlist regardless of auth mode.
- The `/usage` probe (`src/usage-probe.ts`) is **subscription-only** (it parses subscription session JSONL / usage limits); under `api-key` it would **no-op** (or surface API-console billing instead — open question).

**Touch-points:** `authMode` setting + persistence; the three spawn builders above (mode-conditional `--bare` / env injection); `src/usage-probe.ts` no-op guard; settings UI surface; docs.

**Open design questions:**

1. Per-operator global `authMode`, or per-repo / per-spawn-kind (e.g. cheap namer on sub, critic on API key)?
2. Cost surfacing under `api-key` — where does spend show when `/usage` no-ops? API-console only, or a Shepherd-side meter?
3. Key storage / scoping — env-only, or a settings-stored secret? Egress/secrets-handling review needed.
4. Does footing (C) warrant a third `authMode` value (`agent-sdk-credit`), or is it out of scope for this sketch (it reopens the thesis — §2(C))?

---

## 5. Question for Anthropic

The load-bearing external action — audit **R1 Action 1**, tracked separately on **issue #647**. Ready to send to Anthropic support/policy verbatim:

> On a Claude Pro/Max subscription, is keystroke-driven automation of interactive Claude Code sessions (a harness that types prompts into a real interactive `claude` PTY to do automated/unattended work) permitted under the Consumer Terms — or must automated/unattended usage go through the Agent SDK credit (`claude -p` / Agent SDK + `CLAUDE_CODE_OAUTH_TOKEN`)? Specifically: after June 15 2026, are automated spawns that use the interactive CLI form expected to draw from the Agent SDK credit, and is using the interactive channel to avoid that credit considered a fair-use / circumvention violation?

Anthropic's answer is the single thing that can move the audit verdict from "partially compliant / material risk" to cleared (footing A), or confirm that (B)/(C) is the required path.

---

## Sources

- Anthropic Consumer Terms — <https://www.anthropic.com/legal/terms>
- Claude Code authentication (subscription OAuth, `claude setup-token` / `CLAUDE_CODE_OAUTH_TOKEN`, June 15 2026 metering note) — <https://code.claude.com/docs/en/authentication>
- Agent SDK credit support article (credit sizes, billing) — <https://support.claude.com/en/articles/15036540>
- Claude Code legal & compliance (which terms govern which plan) — <https://code.claude.com/docs/en/legal-and-compliance>

---

_Companion to the [ToS compliance audit](./claude-anthropic-tos-compliance-audit.md) · 2026-06-13 · Engineering compliance reasoning, not legal advice._
