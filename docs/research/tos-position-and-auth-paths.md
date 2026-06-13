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
- **Offer (B) as a first-class, clearly-compliant opt-in** for risk-averse operators who cannot accept R1's ambiguity. The Commercial/API path sidesteps the automation clause entirely and closes the training-by-default exposure; its cost is metered API rates and the architectural change now shipped in §4. **(B) is available as of v1.30.0 — Settings → Session → Auth Mode.)**
- **Record (C) as the lowest-legal-risk, explicitly-permitted automation channel**, whose adoption is a deliberate **product decision** because it reopens the interactive-substrate thesis (§2(C)). Not recommended as default, but honestly the strongest R1 footing.

**Internal-consistency flag.** Surfacing (B)/(C) revisits **PRD §2's non-goal**, whose original wording was the absolute _"No Agent SDK, no `claude -p`. Ever, on a sub."_ This work has softened that line from the absolute non-goal to a _by-default_ position that cross-refs this doc, so the two stay consistent; this doc names the tension plainly so neither ships a contradictory stance. If (C) is ever adopted, the §2 non-goal must be rewritten further, not silently left standing.

---

## 4. As-built: (B) API-key mode — shipped v1.30.0 (issue #660, closing R1 Action 3)

> **SHIPPED in v1.30.0 (issue #660, closing R1 Action 3 and also R5).** The sketch below has been superseded by the as-built notes. What follows is the accurate description of what shipped.

**Shape.** A global operator setting `authMode`: `subscription` (default, footing A) | `api-key` (footing B). Env seed: `SHEPHERD_AUTH_MODE`. Configured in Settings → Session.

**How key delivery works — NOT `--bare`.** All existing spawn flags are kept intact. The API key is not passed as a raw environment variable. Instead Shepherd writes a `0600` `apiKeyHelper` shell script and names it in the spawn's `--settings` JSON. Claude Code's `apiKeyHelper` mechanism invokes the script to retrieve the key at spawn time — so the key never appears in `ps` output, process environment, host logs, or the database (only the script path is stored).

**Credential masking — two paths by spawn type:**

- **bwrap-membrane spawns** (`standard`/`autonomous` profile): the subscription credential (`~/.claude/.credentials.json`) is masked in-place via a last-wins `--overlay-tmp-upper` binding that presents an empty file; the `apiKeyHelper` is bound into the membrane. The spawned `claude` has no subscription credential to pick up and uses the key exclusively.
- **Non-membraned spawns** (main interactive session, `trusted` profile): Shepherd provisions a credential-less `CLAUDE_CONFIG_DIR` — a symlink mirror of `~/.claude` with the credential file omitted — and sets that dir in the spawn. No subscription login is presented, so Claude's "Use custom API key" approval prompt cannot hang an unattended spawn.

**Secondary spawns** (critic, plan-gate reviewer, namer, classifier, recap, distiller) all route through the same `apiKeyHelper` mechanism. None use `--bare`; hooks, skills, MCP, and `CLAUDE.md` are preserved exactly as in subscription mode.

**Egress:** unaffected — `api.anthropic.com` was already on the autonomous-profile egress allowlist (PR #601) regardless of auth mode.

**`/usage` under api-key:** the `/usage` probe is subscription-only (parses subscription session JSONL/limits). Under `api-key` it no-ops to an explicit "subscription-only" state — it does **not** show a fake zero meter. The UI surfaces a clear "subscription-only feature" message pointing the operator to the Anthropic Console for spend tracking.

**Fail-closed:** `api-key` mode with no key configured refuses the main-session spawn outright and degrades secondary spawns to an error state. It **never** silently falls back to subscription billing.

**Key custody:** operator pastes the key in Settings → Session; Shepherd writes the `0600` `apiKeyHelper` script and stores only its path. The raw key is never written to the DB, process env, or host logs.

**Honest residual:** the `apiKeyHelper` script is readable (`cat`-able) by a hijacked in-sandbox agent — host `ps`/log hygiene only, not in-membrane secrecy. This is the same class as audit R3/R4 (in-membrane token readability, documented in commit ce6a4501 and [`docs/sandbox-security.md`](../sandbox-security.md)).

**Resolved design questions (were open in the original sketch):**

1. **Scope:** global `authMode` only (per-repo / per-spawn-kind granularity is a future extension, not shipped).
2. **Cost surfacing:** minimal — `/usage` no-ops with a Console pointer; no Shepherd-side spend meter.
3. **Key storage:** `apiKeyHelper` script path only; raw key never persisted in DB or env.
4. **Footing (C):** excluded from scope — it reopens the interactive-substrate thesis (§2(C)) and remains a deliberate non-goal by default.

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
