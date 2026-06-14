# Shepherd — Effort & Maturity Analysis + Open-Source Launch Plan

> Research deliverable. Part 1 measures the codebase and its evolution since inception.
> Part 2 turns those findings into a marketing plan for open-sourcing Shepherd next week.
> Authored 2026-06-14. Figures are point-in-time snapshots from git + `gh`.

---

## Part 1 — Effort & maturity analysis

### 1.1 Headline metrics

| Dimension                  | Value                                          | How measured                             |
| -------------------------- | ---------------------------------------------- | ---------------------------------------- |
| Age (first commit → today) | **~15 days** (2026-05-30 → 2026-06-14)         | `git log --all --reverse`                |
| Commits (all refs)         | **2,349**                                      | `git rev-list --count --all`             |
| Merged PRs                 | **596** (PR numbers reach #687)                | `gh pr list --state merged`              |
| Releases                   | **31** (v1.0.0 → v1.30.0)                      | `CHANGELOG.md`                           |
| Source LOC (ts/svelte/css) | **~151,000**                                   | `wc -l` over tracked source              |
| Tracked files              | **762** (485 `.ts`, 85 `.svelte`)              | `git ls-files`                           |
| Test files                 | **278**                                        | `git ls-files` over `test/` + `*.test.*` |
| Languages                  | TypeScript (server + UI), Svelte 5, Tailwind 4 | repo                                     |
| License                    | **Apache-2.0** (already set)                   | `package.json`, `LICENSE`                |
| Primary authors            | Patrick Lenz (lead), Kai Osthoff               | `git shortlog`                           |

**Derived velocity:** ~39 merged PRs/day, ~157 commits/day, ~2 releases/day, ~256 net LOC/PR.
For a two-person human team this cadence is implausible — which is the central fact of the analysis.

### 1.2 The defining fact: Shepherd is built by Shepherd

The velocity above is not human throughput. Shepherd is **self-hosted mission control that spawns
and steers a herd of interactive `claude` agents**, and the overwhelming majority of those ~590 PRs
were authored by agents running _under Shepherd, building Shepherd_, behind Shepherd's own gates.
The repo is its own most demanding customer. That is the proof point, and it should anchor both the
maturity verdict and the launch story:

- Every one of those PRs passed the same pipeline the product sells: **Plan gate** (adversarial plan
  review before an autonomous run), **Critic** (read-only review the moment CI goes green),
  **Merge train** (rebase + re-verify anything behind its base before it lands), and **hygiene
  gates** (linear branches, locale-catalog parity, feature-catalog completeness, dead-code/
  complexity audit).
- The dogfooding is total: the discipline features exist _because_ uncontrolled parallel agent work
  visibly erodes quality, and they were hardened against the project's own output.

This reframes the velocity from "suspiciously fast" to "the product working." 590 reviewed,
gated, released PRs in 15 days **is the demo.**

### 1.3 Effort assessment

- **Concentration.** Effort is compressed into a single ~2-week sprint of sustained, high-intensity
  work — 31 tagged releases via automated release-please, ~2/day, never stalling. This is not a
  side project that accreted over a year; it is a focused build-out.
- **Breadth.** The 762 files span a Bun server (`src/`, ~107 files incl. `forge/`), a SvelteKit UI
  (`ui/`, 275 files), an MV3 browser **extension** (`extension/`, 56 files), a self-hosted **CI
  runner** (`ci/`, 25 files), deploy/systemd plumbing, and 81 docs files. This is a full product
  surface, not a prototype.
- **Depth of guardrails.** The effort visibly went disproportionately into _discipline_, not just
  features: plan gate, critic, learnings flywheel, readiness analyzer, merge train, egress
  allowlist firewall, epic integration branches, onboarding/regression harness. Roughly half the
  product is "how to keep agent output shippable," which is the hard, defensible half.

### 1.4 Maturity assessment

Despite its age, the codebase exhibits maturity markers usually seen in projects 10–50× older:

**Strong (ship-ready) signals**

- **Release engineering** — conventional commits, release-please automation, semantic versioning to
  v1.30.0, CHANGELOG maintained automatically.
- **Test coverage breadth** — 278 test files across server + UI (vitest) layers.
- **CI/CD discipline** — PR-hygiene workflow, pre-push hooks, a self-hosted runner, branch-linearity
  enforcement, dead-code/complexity audit (`fallow`) wired as a gate.
- **i18n from day one** — fully internationalized (EN + DE) with a catalog-parity gate and a custom
  union merge driver to auto-resolve concurrent catalog edits — an engineering nicety most mature
  projects never reach.
- **Design system** — semantic token layer (`app.css`), a live `/design-system` reference page,
  documented component recipes, enforced anti-drift conventions.
- **Documentation** — README, PRD, PRODUCT.md (with an articulated brand voice), DESIGN.md,
  CONTRIBUTING.md, plus a `docs/research/` corpus including a **ToS compliance audit** and an
  **auth-path evaluation**. The project reasons about its own legal posture in writing.
- **Security posture** — autonomous egress allowlist firewall (netns + nftables), sandbox model,
  read-only reviewer agents, fail-closed defaults, a `sandbox-security.md` doc.

**Maturity gaps / open risks** (material for the launch)

1. **ToS R1 ambiguity (highest-stakes).** Shepherd's compliance model — that _interactive_
   keystroke-puppeting on a subscription is permitted where programmatic SDK/`claude -p` is not — is
   the project's explicitly-stated **position, not Anthropic-confirmed**. It is the open question in
   the project's own audit (R1). An opt-in API-key footing (B) exists as the clearly-compliant path.
   This is a product strength (honestly reasoned, both footings shipped) **and** the single biggest
   reputational variable in a public launch.
2. **Bus factor.** Effort is concentrated in one lead author. Open-sourcing is partly a mitigation
   (contributors), partly an amplifier of support load.
3. **Single-operator design.** The product is deliberately single-operator/self-hosted; "team" and
   multi-tenant are non-goals. This bounds the addressable audience — a feature for messaging, not a
   defect, but it must be set expectation-first.
4. **Newness vs. trust.** 15 days old means little external battle-testing. The dogfooding story
   substitutes internal rigor for external time-in-market; the launch must make that trade explicit.

### 1.5 Verdict

Shepherd is a **mature-beyond-its-age, discipline-first product** that has compressed roughly a
year of conventional engineering into two weeks by being its own first and hardest user. Its
maturity is real (tests, CI gates, i18n, design system, security model, docs), and its single
genuine uncertainty is external, not internal: the unresolved ToS reading. It is technically ready
to open-source; the launch is a **positioning and risk-framing exercise**, not an engineering one.

---

## Part 2 — Open-source launch marketing plan (target: next week)

> Brand constraints (from `PRODUCT.md`) are non-negotiable inputs. Voice is **technical, composed,
> earned** — "an operator talking to an operator." No marketing warmth, no exclamation, no
> hand-holding. Visuals read like mission telemetry: monospace, dense, phosphor-green, status pips
> and gauges that mean something. Every asset below must pass that filter.

### 2.1 Core narrative (the one thing to land)

**Headline (decided): "Shepherd builds Shepherd."** The artifact is the pitch — ~590 reviewed,
gated PRs in 15 days, agents building the product behind the product's own review gates. Lead with
the proof, not the adjective; it has a ring and it is true.

Supporting line: **"Run a herd of real Claude Code agents — and ship only what survives review."**

The launch is not "another agent dashboard." Two ideas, in this order:

1. **Parallelism without losing oversight** — one operator drives many _genuine interactive_ `claude`
   sessions, observing and steering, on their own server and subscription.
2. **Opinionated shipping discipline** — plan gate, critic, merge train, hygiene gates institutionalize
   the engineering rigor that uncontrolled parallel agents erode.

> **Headline ↔ ToS coupling (read §2.9).** "Shepherd builds Shepherd" is the strongest possible
> proof _and_ a live demonstration of large-scale automated subscription use — exactly the behaviour
> R1 leaves unresolved. Keeping the headline means the ToS framing in §2.9 is no longer optional
> polish; it is the thing that makes the headline safe to say. The two decisions are one decision.

### 2.2 Audience segments (in priority order)

| #   | Segment                                        | Why they care                                                     | Where they are                            |
| --- | ---------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------- |
| 1   | Solo power-users on Claude Max/Pro             | They already run many `claude` sessions and _are_ the bottleneck  | HN, r/ClaudeAI, X/AI-dev, Claude Discords |
| 2   | AI-eng tinkerers / self-hosters                | Self-hosted, own-server, own-subscription resonates               | HN, Lobsters, r/selfhosted, Show HN       |
| 3   | Eng leaders curious about agent-built software | The _discipline_ pillar (gated agent output) is the real interest | LinkedIn, X long-form, newsletters        |
| 4   | Anthropic ecosystem watchers                   | The ToS-compliance reasoning is itself notable                    | X, HN ToS threads                         |

Explicitly **not** the audience: teams wanting multi-tenant SaaS, non-technical users. Say so early
to set expectations and protect the brand.

### 2.3 Messaging pillars (and the proof for each)

1. **Mission control for interactive Claude Code.** Proof: live HUD, many panes, steer-by-typing.
2. **Opinionated about how agent software ships.** Proof: plan gate / critic / merge train, the
   self-build story, 278 tests + gates.
3. **Yours: own server, own subscription, single operator.** Proof: self-hosted, ToS model, API-key
   footing B for the compliance-cautious.
4. **Honest about the open question.** Proof: the published ToS audit (R1) and dual auth footings.
   Turning the risk into a transparency asset is on-brand ("earned") and defuses the obvious attack.

### 2.4 Copy kit (drafts, ready to refine)

**Taglines (pick 1–2; A/B the top two):**

- `Run the herd. Ship what survives review.`
- `Mission control for interactive Claude Code.`
- `Many agents. One operator. One bar everything clears.`
- `Self-hosted. Your subscription. Your server. Your herd.`

**GitHub repo "About" (≤120 chars):**

> Self-hosted mission control for interactive Claude Code — run a herd of agents, ship only what
> clears review.

**One-paragraph elevator (README / Show HN intro):**

> Shepherd is self-hosted mission control for _interactive_ Claude Code. It spawns genuine `claude`
> sessions in isolated git worktrees, bridges each terminal to your browser or phone, and lets one
> operator run a whole herd in parallel — watching status and steering by typing, exactly like a
> human at a terminal. Around those sessions it builds the discipline parallel agent work erodes:
> every plan and PR faces adversarial review, and nothing merges while behind its base. Shepherd
> built itself this way — ~590 reviewed, gated PRs in 15 days.

**Show HN title options:**

- `Show HN: Shepherd – run a herd of interactive Claude Code agents from your browser`
- `Show HN: Shepherd – I let agents build a 150k-LOC product in 15 days, behind their own review gates`

**X/Twitter launch thread (skeleton, 6 posts):**

1. Hook + artifact: "150k LOC, 590 reviewed PRs, 31 releases — in 15 days. Built by a herd of Claude
   Code agents, behind their own review gates. Open-sourcing Shepherd today. 🧵"
2. The problem: you can already run many `claude` sessions; _you_ become the bottleneck and quality
   erodes. Screenshot of the multi-pane HUD.
3. Pillar 1 — observe + steer many real interactive sessions from browser/phone. (GIF)
4. Pillar 2 — the discipline: plan gate → critic → merge train. (diagram)
5. The honest part: it runs on your own subscription/server; the ToS reading is a stated position
   (link the audit) + an API-key footing for the cautious.
6. CTA: self-host in N minutes, Apache-2.0, link. "Not for teams. For the one operator who's tired
   of being the bottleneck."

**LinkedIn post (eng-leader register):** lead with the discipline pillar, not the herd — "What does
it take to trust software agents wrote? We made the pipeline gate itself" — then the self-build
metrics as evidence.

**Reddit (r/ClaudeAI, r/selfhosted):** plain, no-hype, operator-to-operator; open with "I built this
because I was running 8 `claude` windows and losing track." Link, invite teardown.

### 2.5 Imagery / visual direction

Stay inside the brand: **monospace, dense, phosphor-green on near-black, status pips, gauges.** No
stock photography, no gradient SaaS hero, no rounded-pastel illustration.

- **Hero shot:** the live HUD — many terminal panes, status pips (working / idle / blocked), one
  selected pane mid-steer. This is the single most important asset; it sells pillar 1 instantly.
- **Hero GIF/loop (≤6s):** a blocked agent lights up → operator types one steer → it resumes. Shows
  "observe + steer" in one motion.
- **Pipeline diagram:** plan → plan gate → implement → CI → critic → merge train → main, as a clean
  telemetry-style flow (D2/SVG, monospace labels). Sells pillar 2.
- **"Built by itself" data card:** a single dense stat panel (15 days · 590 PRs · 31 releases · 278
  tests · all gated) styled as an instrument readout. Becomes the shareable OG image.
- **Mobile shot:** the herd on a phone — proves the "check at 2am from anywhere" claim.
- **OG/social card:** the data card or hero shot + tagline; 1200×630, monospace, green accent.

Note: the repo already has a `mockup/` dir and a design system — reuse those tokens so launch assets
can't drift from the product.

### 2.6 Pitches (per channel, one-liners)

- **HN (Show HN):** lead with the self-build artifact + "open-sourced, Apache-2.0, self-hosted."
  Expect (and pre-empt) the ToS debate in the first comment with a link to the audit.
- **Product Hunt** (optional/secondary — audience skews non-technical): "Mission control for a herd
  of AI coding agents — self-hosted, opinionated about shipping quality."
- **Newsletters (TLDR, Pragmatic Engineer-adjacent, AI-tinkerer lists):** angle = "agents built a
  150k-LOC product behind their own review gates" — the _process_ is the story.
- **Claude/Anthropic Discords & r/ClaudeAI:** practical "stop being the bottleneck across N sessions."

### 2.7 Video ideas (ranked by ROI for launch week)

1. **90-second hero demo (must-have).** Cold open on the HUD; spawn 3 agents on a real repo; one
   gets blocked → steer it; a PR goes CI-green → critic posts a verdict → merge train lands it. No
   voiceover or terse operator-register VO. End on the data card. _This is the launch video._
2. **3–4 min "Shepherd builds Shepherd" mini-doc.** Screen-recorded session of agents shipping a
   real feature in this repo end-to-end through the gates. The proof-by-dogfooding piece; strongest
   for the eng-leader segment.
3. **60-second "the discipline" explainer.** Animated pipeline diagram walking plan gate → critic →
   merge train; for people who bounce off "another dashboard."
4. **Loom-style honest walkthrough of the ToS model (optional).** Operator explains the
   subscription-vs-API-key footings and links the audit. High-trust, defuses the launch's main
   attack vector. Risk: amplifies the topic — decide deliberately (see open questions).
5. **15s vertical cuts** of #1 for X/Reddit/Shorts.

### 2.8 Launch-week timeline (next week, T = launch day)

| When           | Action                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T-3            | Freeze a clean `main`; final README pass; ensure repo is public-ready (no secrets, scrub `CI_RUNNER` var per project note); record hero demo.                |
| T-2            | Cut hero GIF + data card + pipeline diagram; draft HN/Show HN, X thread, LinkedIn, Reddit copy; line up the ToS-audit link.                                  |
| T-1            | Soft-share with a few trusted operators for teardown; fix first-impression friction in install/onboarding; prep FAQ (esp. ToS + "is this allowed?").         |
| **T (launch)** | Make repo public → Show HN (early-morning PT) → X thread → r/ClaudeAI + r/selfhosted → Discords. Be present all day to answer (ToS questions will dominate). |
| T+1            | LinkedIn eng-leader post + the "builds itself" mini-doc; respond to HN thread; capture FAQ from real questions into README.                                  |
| T+2..7         | Newsletter outreach; iterate copy from what landed; open "good first issue" set to convert interest into contributors (bus-factor mitigation).               |

### 2.9 ToS framing — the load-bearing decision (elaborated)

This is the one decision the rest of the launch bends around, and your two choices —
**launch independently** (no Anthropic heads-up) and **"Shepherd builds Shepherd" as the headline**
— both _raise_ its stakes, not lower them:

- **Independent launch removes the relationship buffer.** If you'd coordinated with Anthropic first,
  a "we read this as permitted, do you agree?" conversation could happen in private. Launching cold
  means the first time Anthropic engages may be _in public, on your HN thread_. The framing has to
  be defensible on its own, with no backchannel to soften it.
- **The headline flaunts the contested behaviour.** "Agents shipped 590 PRs on a subscription" is a
  vivid, screenshot-able instance of automated/largely-unattended subscription use — precisely what
  audit R1 says no Anthropic clause blesses, and what the metered Agent SDK credit (live 2026-06-15)
  signals is _intended_ to flow through a different, capped channel. The better the demo lands, the
  louder the "wait, is that allowed?" reply.

So the framing isn't damage control bolted on at the end — it is what lets you keep the headline.

#### The spectrum (and why only one option survives the brand)

| Posture                     | What you'd say                                                                                                 | Verdict                                                                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Compliance-confident**    | "We type like a human, so it's fine."                                                                          | ✗ Reject. The repo's own audit calls this a _position, not settled fact_. Overclaiming is the single thing that breaks "earned" — and invites a takedown. |
| **Silent / omit**           | Don't mention ToS; just ship.                                                                                  | ✗ Reject. HN finds it in comment #2. Silence reads as evasion or ignorance; both fatal.                                                                   |
| **Compliance-first**        | Lead with footing B (API key); treat sub use as niche.                                                         | ~ Safe but self-defeating — it guts the "your own subscription / interactive substrate" thesis _and_ the self-build headline.                             |
| **Transparency-forward** ✅ | "Here's our honest read of an open question — and a clearly-compliant mode if you can't accept the ambiguity." | **Recommended.** On-brand ("earned"), pre-empts the gotcha by saying it first, and is _already what the repo ships_.                                      |

**Recommendation: transparency-forward, with footing B kept visibly one click away.** You are not
inventing a posture — `docs/research/tos-position-and-auth-paths.md` already states it. Marketing's
job is to surface it faithfully, not to spin it. Concretely:

1. **Say the open question out loud, first.** Frame R1 as honestly unresolved: subscription
   keystroke-puppeting for automated work is Shepherd's good-faith reading, **not** Anthropic-confirmed.
   Link the audit. Owning the ambiguity is disarming; defending a clearance you don't have is not.
2. **Put the clearly-compliant path right next to it.** Footing B (API key → Commercial Terms,
   no-train-by-default, shipped v1.30.0) is the answer to "but I can't run my business on an
   ambiguity." It converts the risk from a dealbreaker into a _choice the operator owns_.
3. **Never overclaim.** No "fully compliant," no "Anthropic-approved," no "loophole." The honest
   register _is_ the credibility.

#### Reconciling the headline with the framing (so both can stand)

The headline and the contested footing must be **decoupled** so the proof doesn't depend on the
ambiguity:

- **The self-build proves the _gates_, not the puppeting.** Frame the 590-PR metric as "PRs that
  survived adversarial review," i.e. evidence the _discipline_ works — which is footing-agnostic.
  The story is about quality control, not about which auth channel paid for the tokens.
- **Be ready to say it runs on footing B too.** If pressed ("isn't your whole demo a ToS
  violation?"), the clean answer is: the pipeline is identical under the Commercial API key — the
  proof of discipline doesn't require subscription puppeting at all. That single sentence removes
  the headline's exposure.

#### Independent-launch posture (good-faith, non-adversarial)

Launching without coordinating does **not** mean launching combatively. Keep the door open so that
_if_ Anthropic notices, the public record already reads as good faith:

- The repo already contains a **drafted question to Anthropic** (`tos-position-and-auth-paths.md` §5).
  Keep it public and link it — it signals "we want to be told," not "we're dodging."
- Tone toward Anthropic stays respectful throughout: "we'd genuinely welcome a definitive answer and
  will comply with it." Never frame the model as beating the terms.
- Decide in advance the response if Anthropic asks you to stop: footing B (and footing C, the
  explicitly-permitted metered Agent SDK path) are your graceful-degradation answers, not a fight.

#### Canonical pinned answer (pre-write; pin on HN + paste into the README FAQ)

> **"Is this against Anthropic's Terms?"** Honest answer: the terms don't directly address it.
> Shepherd drives the official, unmodified `claude` CLI by typing into a real interactive session —
> it never uses the Agent SDK or `claude -p`. Our good-faith reading is that interactive use is
> permitted; that's our _position_, not an Anthropic ruling, and we say so in our published ToS
> audit [link]. If you can't accept that ambiguity, Shepherd ships an API-key mode (Commercial
> Terms, no-train-by-default) that sidesteps the question entirely. We've drafted the question to
> Anthropic [link] and will comply with whatever they answer.

#### Do / don't (hand this to anyone writing launch copy)

| Do                                                             | Don't                                         |
| -------------------------------------------------------------- | --------------------------------------------- |
| "Our good-faith reading / our position"                        | "Fully ToS-compliant" / "Anthropic-approved"  |
| "The terms don't directly address this; here's our read"       | "We found a loophole" / "technically allowed" |
| "Drives the official, unmodified CLI — no SDK, no `claude -p`" | "We bypass / get around the limits"           |
| "Can't accept the ambiguity? Use API-key mode."                | Hiding footing B or burying the audit         |
| Link the audit + the drafted Anthropic question                | Imply Anthropic has blessed it                |

### 2.10 Launch risks & mitigations

- **ToS blowback (primary).** Mitigate with radical transparency: publish the audit, lead with the
  honest "stated position, not confirmed" framing, surface the API-key footing prominently. Do **not**
  overclaim compliance — the brand value is "earned," and overclaiming is the one thing that breaks it.
- **"Is this against Anthropic's terms?" derail.** Pre-write the canonical answer; pin it; link the
  audit; keep replies operator-calm.
- **Over-broad expectations.** State "single-operator, self-hosted, not a team SaaS" up front so the
  non-goal isn't read as a missing feature.
- **Support load spike** from a one-author project. Ship a tight README + FAQ + "good first issue"
  set so interest routes to docs/contribution, not the maintainer's inbox.
- **Velocity skepticism ("AI slop").** Counter with the gates, the 278 tests, and the published
  process — the answer to "how is this not slop" is the entire discipline pillar.

### 2.11 Questions — decided & still open

**Decided (this round):**

- ✅ **ToS framing** → transparency-forward, footing B visibly one click away (elaborated in §2.9).
- ✅ **Anthropic coordination** → launch independently. Posture stays good-faith/non-adversarial;
  keep the drafted Anthropic question public (§2.9).
- ✅ **Headline** → "Shepherd builds Shepherd" is _the_ headline (coupled to the ToS framing, §2.1).
- ✅ **Repo home** → stays at `erwins-enkel/shepherd`.

**Still open (need your call before T-1):**

1. Primary launch channel — Show HN as the spearhead (recommended) vs. X-thread-first?
2. Ship video #4 (ToS walkthrough) at launch, or hold it? It defuses but also amplifies the topic.
   _Given the independent launch + the contested headline, lean toward shipping it — it front-runs
   the gotcha in your own calm voice rather than letting the thread set the tone._
3. Footing B at launch — present it feature-equal, or explicitly "for the compliance-cautious"? (The
   §2.9 framing assumes the latter: default A, B as the clearly-compliant opt-in.)
4. Does the "Shepherd builds Shepherd" demo/mini-doc (video #2) run on footing A or footing B? Running
   the _public_ proof on B removes the headline's ToS exposure entirely (§2.9) — worth considering.
