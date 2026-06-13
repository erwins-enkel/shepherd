# Terms-of-Service compliance audit: Shepherd × Claude/Anthropic

**Verdict: PARTIALLY COMPLIANT — material residual risk, one dominant open question.**
Shepherd's _auth posture_ (operator's own subscription OAuth, official unmodified Claude Code CLI, no Agent SDK / no `claude -p`, no token forwarding, no harness spoofing, single-operator, no reselling) keeps it clear of the conduct Anthropic actually enforced against in the Feb-2026 third‑party‑OAuth crackdown. The **dominant unresolved risk is not authentication — it is that Shepherd performs automated, largely-unattended work by _puppeting interactive_ Claude Code sessions (typing keystrokes via `herdr`), thereby drawing on the larger _interactive_ allowance instead of the metered _Agent SDK_ channel that Anthropic has explicitly designated for automated subscription usage.** That distinction ("we type like a human, so it's interactive use") is Shepherd's load-bearing legal theory, and **no current primary Anthropic clause explicitly blesses it.** It can be read as circumventing the very metering Anthropic introduced for this use case (effective **June 15, 2026** — i.e. ~2 days after this audit).

> **Not legal advice.** This is an engineering/compliance review by an AI agent against published Anthropic policy as of **2026-06-13**. The policy surface here is _actively shifting_ (the most decisive facts are days/weeks old and forward-looking). Treat conclusions as a risk map to take to Anthropic and/or counsel, not a clearance.

---

## TL;DR risk register

| #      | Area                                                        | Risk                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Severity    | Status                                                                                                       |
| ------ | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------ |
| **R1** | **Interactive-puppeting to avoid Agent-SDK metering**       | Shepherd routes automated work through the interactive channel; the Consumer Terms ban automated access "through a bot, script, or otherwise" and Anthropic's _explicit_ automation carve-out is the (now-metered) Agent SDK / `claude -p` path, not keystroke-puppeting of interactive panes.                                                                                                                                                                  | 🔴 **High** | **Open / unverifiable from primary clauses**                                                                 |
| **R2** | Parallel fan-out on one subscription                        | Many concurrent Claude Code instances on a single Pro/Max sub pushes against fair-use / power-user rate limiting; no primary clause confirmed, but Anthropic has actively curbed high-volume single-sub usage.                                                                                                                                                                                                                                                  | 🟠 Medium   | Mitigated (usage ceiling + `maxAuto` caps), not eliminated                                                   |
| **R3** | OAuth token exfiltration                                    | `~/.claude/.credentials.json` stays readable inside the agent sandbox so the agent can authenticate. The autonomous-mode egress allowlist (`src/egress.ts`, PR #601 / #551, merged) now confines outbound traffic to Anthropic + GitHub hosts, closing the main exfil channel for autonomous agents. Residual: the token is still readable in-membrane (defence-in-depth gap), and the netns firewall covers the **autonomous** profile, not attended sessions. | 🟡 Low-Med  | **Largely mitigated** (egress allowlist shipped #601); residual is defence-in-depth + attended-mode coverage |
| **R4** | Untrusted content / prompt injection into unattended agents | Research agent browses untrusted web; agents ingest third-party repo/PR/issue text under `--dangerously-skip-permissions`. Indirect prompt injection can steer an unattended agent.                                                                                                                                                                                                                                                                             | 🟠 Medium   | Inherent; harden                                                                                             |
| **R5** | Data / training of proprietary code                         | Consumer (subscription) plans can route inputs into model training depending on account settings — unlike the no-train-by-default Commercial/API path.                                                                                                                                                                                                                                                                                                          | 🟡 Low-Med  | Operator setting; **verify**                                                                                 |
| **R6** | "Third-party harness piloting a consumer account" line      | Anthropic banned third-party tools that pilot consumer accounts via OAuth and tightened anti-spoofing. Shepherd avoids the banned conduct _today_, but the line is being actively tightened.                                                                                                                                                                                                                                                                    | 🟡 Low      | On the permitted side **as built**; monitor                                                                  |
| **R7** | Reselling / multi-tenant / SaaS                             | Prohibited.                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 🟢 None     | Clean by design (single-operator, BYO-sub, self-hosted)                                                      |

---

## 1. What Shepherd actually does with Claude (current state)

Established from a full read of the codebase (root server, `ui/`, `extension/`, scripts):

- **One auth path: the operator's own Claude Pro/Max subscription OAuth** (`~/.claude/.credentials.json`). No `ANTHROPIC_API_KEY`, no token relay, no impersonation. The reviewer spawn even carries an explicit comment refusing `--bare` _because_ `--bare` would force API-key auth and break subscription OAuth (`src/reviewer-argv.ts:45-47`).
- **Every** LLM invocation is a real **interactive** `claude` (Claude Code) process spawned through `herdr` into a PTY. This includes both human-facing sessions _and_ all automation: the namer (`src/namer-llm.ts`), autopilot stop-classifier (`src/autopilot-llm.ts`), PR critic (`src/review.ts` + `src/reviewer-argv.ts`), plan-gate reviewer (`src/plan-gate.ts`), distiller (`src/distiller.ts`), recap (`src/recap.ts`), and the `/usage` probe (`src/usage-probe.ts`). **Zero** uses of the Agent SDK or `claude -p` anywhere.
  - Notably, the automation spawns pass the prompt as a _positional_ argument with `--permission-mode dontAsk` + an `--allowedTools` allowlist and exit after writing a result file. These are **functionally headless one-shots wearing the interactive CLI's clothing** — fully automated, no human, but launched via the interactive runtime to stay on the interactive allowance.
- **Unattended automation surfaces:** auto-drain (spawns agents from a backlog), autopilot (steers a blocked agent by injecting keystrokes), critic-on-PR, plan-gate, merge train, distiller, recap. Concurrency is bounded per-repo by `maxAuto` and gated by a `usageCeilingPct` that pauses drain near the subscription's usage limit (`src/drain-core.ts`, `src/drain.ts`, `src/store.ts`).
- **Data egress to Anthropic:** task prompts, GitHub/Gitea issue + PR text, PR diffs, git history, repo code, uploaded images, operator-curated house rules. The autonomous-mode egress allowlist (`src/egress.ts` + `src/egress-watch.ts`, **shipped in PR #601 / closes #551**) enforces a per-spawn netns firewall (slirp4netns + nftables + dnsmasq) that confines outbound traffic to `api.anthropic.com` + `statsig.anthropic.com` (and GitHub hosts), with a DNS-drop watcher emitting `egress_drop` security alerts. The OAuth token stays readable inside the membrane so the agent can authenticate, but egress now bounds where it can go. (Note: `README.md:140` still says "not yet implemented" — that paragraph is **stale**; #601 shipped the code without updating it. Fix recommended below.)
- **Scope:** single operator, bring-your-own-subscription, self-hosted, bound to loopback and exposed (if at all) over Tailscale; optional `SHEPHERD_TOKEN` bearer. No SaaS, no multi-tenant, no cloud orchestration. Multi-instance same-repo coordination uses _independent_ instances each on its _own_ login.
- **Stated philosophy (PRD.md §3 "ToS compliance model"):** "Sessions must be genuinely interactive (real PTY via herdr, not `claude -p`) … We observe, we don't impersonate … We steer by typing, like a human … Auth = the operator's own login. If a feature can't be done by typing into a real terminal, it doesn't ship." The PRD asserts: _"Anthropic's 2026 crackdown killed programmatic subscription use — Agent SDK and `claude -p` cut off 2026-06-15. Interactive terminal use was NOT banned."_

This audit tests that last assertion against current Anthropic policy.

---

## 2. Which terms govern (confirmed, primary sources)

**Claude Code on a Pro/Max subscription is governed by the Anthropic _Consumer_ Terms of Service**, not the Commercial/API Terms.

- Consumer Terms, verbatim: _"Our Commercial Terms of Service govern your use of any Anthropic API key, the Anthropic Console, or any other Anthropic offerings that reference the Commercial Terms of Service. For clarity, this does not include Claude.ai or Claude Pro use for individuals."_ — <https://www.anthropic.com/legal/terms>
- Claude Code legal docs, verbatim: _"Your use of Claude Code is subject to: Commercial Terms — for Team, Enterprise, and Claude API users; Consumer Terms of Service — for Free, Pro, and Max users."_ — <https://code.claude.com/docs/en/legal-and-compliance>
- Anthropic's consumer privacy article explicitly scopes itself to _"our consumer products such as Claude Free, Pro, Max and when accounts from those plans use Claude Code."_ — <https://privacy.claude.com/en/articles/10023580-is-my-data-used-for-model-training>

**Implication:** Shepherd lives under the Consumer Terms. The Commercial Terms' more permissive automation/data posture does **not** apply unless the operator moves to an API key (Commercial path).

---

## 3. The automation clause and its carve-outs (the crux)

**Consumer Terms §3 ("Use of our Services"), verbatim** — you may not:

> _"Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, … access the Services through automated or non-human means, whether through a bot, script, or otherwise."_ — <https://www.anthropic.com/legal/terms>

Two carve-outs: **(a) API key**, or **(b) where Anthropic "otherwise explicitly permits it."** Shepherd uses no API key, so everything hinges on (b).

**What Anthropic explicitly permits (confirmed, primary):** headless/scripted Claude Code on a subscription via an official long-lived token:

> _"For CI pipelines, scripts, or other environments where interactive browser login isn't available, generate a one-year OAuth token with `claude setup-token`."_ … _"`CLAUDE_CODE_OAUTH_TOKEN` … requires a Pro, Max, Team, or Enterprise plan. It is scoped to inference only and cannot establish Remote Control sessions."_ — <https://code.claude.com/docs/en/authentication>

**And the metering Anthropic attached to it (confirmed, primary):**

> _"Starting June 15, 2026, Agent SDK and `claude -p` usage on subscription plans will draw from a new monthly Agent SDK credit, separate from your interactive usage limits."_ — <https://code.claude.com/docs/en/authentication>; corroborated by <https://support.claude.com/en/articles/15036540> (credit sizes Pro $20 / Max 5× $100 / Max 20× $200, billed at API list rates, opt-in, stops when exhausted).

### Why this is the dominant risk (R1)

Anthropic recognises **two** sanctioned subscription modes:

1. **Interactive** Claude Code (human at the keyboard) → the large interactive allowance.
2. **Headless/scripted** Claude Code (Agent SDK / `claude -p` + `CLAUDE_CODE_OAUTH_TOKEN`) → from **June 15, 2026**, a _separate, smaller_ metered Agent SDK credit.

Shepherd does automated, unattended work but routes it through **mode 1** by puppeting interactive panes — so it consumes the _interactive_ allowance for what Anthropic has designated as _Agent-SDK-credit_ work. The tension:

- The clause bans automated access by "bot, **script, or otherwise**" — broad language; Shepherd _is_ a script driving the session. The "we type like a human" framing is a behavioural argument, not a textual carve-out.
- The only _explicit_ automation permission Anthropic grants on subscriptions is the headless mode it is simultaneously **moving to a metered credit** — a strong signal that automated subscription usage is _intended_ to flow through, and be capped by, that channel.
- Therefore Shepherd's interactive-puppeting is fairly characterised as **circumventing the Agent-SDK metering** — precisely the kind of posture abuse filters and fair-use enforcement target, even though no single clause names it.

**The research could not find any primary Anthropic clause that resolves this for a keystroke-puppeting multi-agent orchestrator.** Shepherd is neither the sanctioned headless mode nor a literal human at a keyboard — it is a third thing the published terms don't directly address. This is the honest center of the audit: **the PRD's "interactive use was not banned" is true for a human; it is _unverified_ for an automated harness that injects keystrokes to stay on the interactive allowance.**

---

## 4. The "third-party harness" line (R6) — Shepherd is on the right side, as built

Anthropic's Feb-2026 enforcement targeted _third-party tools that pilot a consumer account via OAuth_ and _forwarding consumer OAuth tokens into non-Claude-Code clients_, and it "tightened safeguards against spoofing the Claude Code harness," with some accounts auto-banned by abuse filters (secondary reporting: The Register, VentureBeat, AlternativeTo — see Sources; note these survived adversarial verification only weakly and are _reported, not quoted from a primary clause_).

**Shepherd, as built, does the things on the _permitted_ side of that line:** it shells out to the **official, unmodified Claude Code CLI**, which authenticates itself the sanctioned way; it does **not** forward/reuse the OAuth token into any non-Claude-Code client, and it does **not** spoof or reimplement the harness. The token never leaves the `claude` process's own use. This is a genuinely strong, deliberate compliance choice and is why R6 is rated low **as built**.

The caveat: this line is being _actively tightened_, and the distinction between "a harness that types into the official CLI" and "a third-party harness piloting the account" is exactly the kind Anthropic has been narrowing. R6 stays on the watch-list even though Shepherd is clear today.

---

## 5. Secondary risks

- **R2 — Fan-out vs. fair-use.** No primary clause on per-user/anti-circumvention limits survived verification, but Anthropic has publicly curbed high-volume single-subscription "power user" usage (weekly rate limits, July 2025 — TechCrunch). Many parallel agents on one sub is, by construction, super-human consumption. Shepherd's `usageCeilingPct` + `maxAuto` caps are good-faith mitigations and should be treated as load-bearing, not optional.
- **R3 — Token exfiltration.** **Largely mitigated.** The egress allowlist shipped in PR #601 (closes #551, merged 2026-06-13): a per-spawn netns firewall confines autonomous-agent outbound traffic to `api.anthropic.com` + `statsig.anthropic.com` + GitHub hosts, so a hijacked agent can no longer ship the OAuth token to an arbitrary host. Residual surface: (a) the token is still **readable inside the membrane** (defence-in-depth gap — egress bounds where it goes, it doesn't stop the agent reading it), and (b) the netns firewall is the **autonomous** profile; confirm attended sessions are covered or accept that attended runs rely on the operator being present. A leaked token reused elsewhere would still be the _prohibited_ "consumer OAuth outside Claude Code" case, so the defence-in-depth gap is worth narrowing.
- **R4 — Prompt injection into unattended agents.** Inherent to a web-browsing research agent and to ingesting third-party repo/PR/issue text autonomously. Anthropic's own research stresses no agent is immune to indirect prompt injection (claims unverified in this run due to rate-limiting, but the risk is well-established). Mitigations: keep the egress allowlist tight, prefer read-only tool allowlists for unattended reviewers (already done for critic/plan-gate), and keep a human-review gate on destructive/outbound actions.
- **R5 — Training on proprietary code.** Consumer/subscription data _can_ be used for model training depending on the account's model-improvement setting (the precise current wording did not survive verification this run — **verify directly**). The Commercial/API path is no-train-by-default; the subscription path is not necessarily. For proprietary repos, the operator should confirm the training setting is off.
- **R7 — Reselling / multi-tenant.** Cleanly avoided: single-operator, BYO-subscription, self-hosted, no request-routing on behalf of others. 🟢

---

## 6. Recommendations (prioritised)

1. **Resolve R1 directly with Anthropic.** This is the only item that can move the verdict from "partially compliant / material risk" to "cleared." Ask the specific question: _is keystroke-driven automation of interactive Claude Code sessions on a subscription permitted, or must automated/unattended usage go through the Agent SDK credit?_ Until answered, treat the interactive-puppeting model as **at-risk, not blessed** — and say so in `PRD.md` / `PRODUCT.md` rather than asserting "interactive use was not banned" as settled fact.
2. **Offer the sanctioned path as a first-class option.** Support running on the **Commercial/API key** path (Commercial Terms, no automation-clause problem, no training-by-default) and/or the **metered Agent SDK credit** path for users who want a clearly-compliant footing. This de-risks operators who can't accept R1's ambiguity, and is the only mode Anthropic _explicitly_ permits for automation.
3. **Tidy the egress residuals (R3 is already largely fixed by #601).** The exfil channel is closed for autonomous agents; the remaining work is narrowing the in-membrane token-readability gap (defence in depth) and confirming attended-session coverage. Also **fix the stale `README.md:140` paragraph** that still claims the egress allowlist is "not yet implemented" — #601 shipped it without updating that text, which an auditor (this one included) will misread as a live gap.
4. **Keep `usageCeilingPct` + `maxAuto` non-optional and conservative** as documented good-faith fair-use mitigations (R2). Consider surfacing them in the README as a compliance feature, not just a cost control.
5. **Document the data/training posture (R5).** Add an operator note: confirm Claude account model-improvement settings before running proprietary code through Shepherd.
6. **Re-run this audit before relying on it.** The decisive facts are forward-looking and days old; the June 15, 2026 metering change had not taken effect at audit time.

---

## 7. Open questions (need a primary-source or Anthropic answer)

1. Does keystroke-puppeting interactive Claude Code for automated/unattended work fall inside the Consumer Terms automation prohibition, or is it permitted interactive use? _(R1 — no primary clause resolves it.)_
2. After June 15, 2026, are Shepherd's automated spawns (critic, namer, classifier, plan-gate, recap, distiller) expected to draw from the Agent SDK credit even though they use the interactive CLI form — and is using the interactive channel to avoid that credit a fair-use violation? _(R1/R2.)_
3. Is there a confirmed per-user / anti-circumvention / concurrent-session limit on Pro/Max that parallel fan-out could breach? _(R2 — unconfirmed.)_
4. Current exact wording of subscription data-training and retention. _(R5 — unconfirmed this run.)_

---

## 8. Sources

**Primary (high confidence, survived adversarial verification):**

- Anthropic Consumer Terms — <https://www.anthropic.com/legal/terms>
- Claude Code legal & compliance — <https://code.claude.com/docs/en/legal-and-compliance>
- Claude Code authentication (subscription OAuth, `claude setup-token` / `CLAUDE_CODE_OAUTH_TOKEN`, June 15 2026 metering note) — <https://code.claude.com/docs/en/authentication>
- Agent SDK credit support article — <https://support.claude.com/en/articles/15036540>
- Consumer privacy / "is my data used for training" — <https://privacy.claude.com/en/articles/10023580-is-my-data-used-for-model-training>
- Anthropic Usage Policy (AUP) — <https://www.anthropic.com/aup>

**Secondary / reported (treat as reported, not adjudicated — several did not survive verification due to API rate-limiting during the run, i.e. _unverified_, not _disproven_):**

- The Register, "Anthropic clarifies ban on third-party tool access to Claude" (2026-02-20) — <https://www.theregister.com/software/2026/02/20/anthropic-clarifies-ban-on-third-party-tool-access-to-claude/5014546>
- VentureBeat, "Anthropic cracks down on unauthorized Claude usage by third-party harnesses"
- AlternativeTo, "Anthropic officially bans using subscription authentication for third-party Claude use" (2026-02)
- TechCrunch, "Anthropic unveils new rate limits to curb Claude Code power users" (2025-07-28)
- InfoWorld, "Anthropic puts Claude agents on a meter across its subscriptions"

**Verification note.** The web research extracted 113 candidate claims and adversarially verified 25; 6 survived (all auth/governance facts in §2–§3, on primary sources). Many secondary-source claims about the Feb-2026 third-party-OAuth ban registered as _abstentions_ caused by API rate-limiting during verification — they are **reported-but-unverified here, not refuted**. The single most important finding is a **negative**: no surviving primary clause directly addresses an automated keystroke-puppeting multi-agent orchestrator on a single subscription, which is exactly Shepherd's model.

---

_Audit date 2026-06-13 · Method: codebase map (Explore agent) + adversarially-verified web research (deep-research workflow, 108 sub-agents) · Engineering compliance review, not legal advice._
