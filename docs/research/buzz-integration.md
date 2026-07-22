# Research: Should Shepherd integrate with buzz (block/buzz)?

**Verdict: no action now — but not for the obvious reasons, and not permanently.** The two arguments that come to hand first (buzz cures no pain; adopting it costs four services justified by nothing) are both wrong here, and §4 explains why. The real reason to hold is narrower: the pain buzz could address is **real but undated**, and the one question that would settle buzz's fitness for it is **unproven**. Run that spike when the direction gets a date, not before.

This is a read-only research task (per the research directive): the deliverable is this report. No product code changed.

## Scope: this is two questions, with different answers

| Question                                                                                     | Answer                                                                                                                                     |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Should **Shepherd as shipped** — one operator, one instance — integrate with buzz?           | **No.** The HUD, web push (`src/push.ts`) and GitHub already cover status, notification, steering, intake and durable discussion.          |
| Should **federated Shepherd** — several operators, own instance and own sub each — use buzz? | **Genuinely open.** There is one concrete unsolved need (§2), buzz is the first substrate to evaluate (§3), and one spike settles it (§5). |

Conflating the two is what makes this look like an easy "no". It isn't.

## 1. Shepherd's multi-party position, stated precisely

The common reading — "Shepherd is single-operator, so multi-party is out" — is too coarse and leads to the wrong conclusion.

**The bar is on farming, not on participation.** `PRD.md:47` lists "No multi-user / team farming (ToS). Single operator, bring-your-own-Claude (sub)" as a **v1 non-goal**, and `PRD.md:19` groups "multi-user farming" with token hijacking and impersonation. The thing prohibited is **several humans consuming one person's subscription**. Several operators each running their own Shepherd on their own subscription is not that, and is not barred.

**Multi-party is already partly shipped, mediated by GitHub:**

- `src/repo-roles.ts` — `HandoffRole = "self" | "reviewer" | "merger"`, GitHub logins in `.shepherd/roles.json`, stored in-repo (the comment: _"so it travels with the repo and is shared across a team"_). Other humans are already first-class in the handoff model.
- `src/drain-core.ts:16` — the `shepherd:priority` label is _"the ONLY cross-instance coordination point: a second shepherd draining the same forge filters claimed issues out … so every instance agrees on it without sharing config."_ **Multiple Shepherd instances against one forge is a supported configuration today.**

So the question was never "should Shepherd become multi-party". It already is, thinly, with GitHub as the substrate. The question is what that substrate should be as the shape gets more serious.

## 2. The federated shape, and its one concrete pain

**The shape:** each operator runs their own Shepherd, on their own machine, on their own subscription, draining a shared forge. ToS-clean, and already half-built per §1. A real direction — with **no fixed timeline**.

**The pain, in the code's own words** (`src/drain-core.ts:16`):

> The window is narrowed, not eliminated — two instances listing within the claim's set-up latency can still race; local dedup then prevents a single instance double-spawning.

A GitHub label is not an atomic claim. Two instances can list, both see an issue unclaimed, and both spawn. This is the load-bearing unsolved problem of the federated shape, and it is exactly the class of problem a shared coordination layer exists to fix.

**What a shared substrate would have to provide** — five generic primitives: race-free **claims**, a live cross-instance **view**, per-operator **identity**, an **audit** trail of who claimed and steered what, and a shared **surface** where operators and agents both post.

**And what it must _not_ provide: Shepherd's domain model.** Epics, the Plan gate, the Critic, the merge train and the learnings pipeline stay in Shepherd; the substrate carries generic primitives and human-readable summaries only. This keeps coupling low, keeps the substrate swappable, and — decisively for a pre-1.0 dependency — means buzz's churn can't reach Shepherd's model.

## 3. Scoring buzz for the generic-primitives role

| Primitive          | buzz                                                                                            | GitHub (today's substrate)                                            |
| ------------------ | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Identity           | Nostr keypair per human **and per agent**; 16 scopes (`crates/buzz-auth/src/scope.rs`)          | Logins; agents need bot accounts, with seat/permission friction       |
| **Atomic claim**   | `buzz mem patch <slug> --base-hash <hex>` — optimistic concurrency, **exit 5 = write conflict** | Labels + assignment; **the race in §2 is documented and unfixed**     |
| Audit              | Hash-chained SHA-256 log (kind 48001)                                                           | GitHub's own event log — durable, and outlives anything you self-host |
| Discussion surface | Channels (NIP-29 groups)                                                                        | Issues / PR threads, already written to by Shepherd                   |
| **Real-time view** | WebSocket relay — pushes                                                                        | **Polling only. Structurally cannot push, at any effort.**            |
| Ops cost           | Postgres 17 + Redis 7 + MinIO + git volume                                                      | Zero — every instance is already authenticated and already polling    |

Three honest observations:

1. **GitHub already supplies three of five** (identity, audit, discussion) at zero marginal cost. Only the atomic claim and the real-time view are genuinely open.
2. **Real-time is the one thing GitHub can't be made to do.** That matters more for Shepherd than for most products: `PRODUCT.md` describes an instrument, "every pixel is telemetry", and a cross-instance herd view that lags a polling interval is not a herd view. This is buzz's strongest card and it is a structural, not incremental, advantage.
3. **The uncomfortable one: generic-primitives-only excludes exactly what makes buzz special.** NIP-34 git events, kind-40008 diff rendering, the agent-job protocol (43000–43999), the workflow engine — all unused under §2's coupling rule. You'd be adopting buzz for its generic half and leaving its differentiated half on the table. That's not disqualifying, but any evaluation that scores buzz on those features is scoring the wrong thing.

## 4. Two arguments against buzz that do _not_ apply here

Both are the first things a reader will reach for. Both fail on inspection, and the report would be dishonest to lean on either.

**"buzz cures no pain."** False. The claim race in §2 is a real, in-code, acknowledged defect, and `mem patch --base-hash` is a plausible arbiter for it. The pain is undated, not absent — a completely different objection with a completely different remedy (wait, vs. never).

**"The value is circular — the bridge is worth building only if you live in buzz, and living in buzz costs four services justified by nothing."** This is sound **for a reader who does not already run buzz**, and it is the right thing to tell them. It is void for an operator who runs buzz independently: the four-service cost is then sunk, and the marginal cost of using it is only the integration code. Scope this argument to the reader; do not treat it as a property of buzz.

## 5. The discriminating unknown

One question decides whether buzz can hold the federated substrate role, and it is cheap to answer:

> **Does `buzz mem patch --base-hash` behave as a linearizable compare-and-set under concurrent writers from independent clients?**

It has the right shape — `mem hash` reads the current SHA-256, `mem patch --base-hash <hex>` applies a diff conditionally, exit **5** signals write conflict. What is unverified is whether the relay enforces it atomically at the storage layer (Postgres) or merely optimistically at the event layer, where two Nostr events with the same base hash could both be accepted and last-write-wins.

**Design the spike to discriminate, and to be able to fail:** N independent `buzz-cli` clients race to claim the same slug; assert exactly one exit-0 and N−1 exit-5, repeated under artificial latency. Concretely:

- **If it holds** → buzz is a viable federated substrate, and the real-time view (§3) makes it the leading candidate.
- **If it doesn't** → buzz is permanently out of the claim-arbiter role regardless of everything else it offers, and the substrate question reduces to a tiny self-hosted hub, an elected coordinator Shepherd, or hardening the GitHub claim (e.g. assign-then-read-back with deterministic lowest-wins).

**Run this when federation gets a date — not now.** It is the correct Phase-0 gate for that work, and running it early buys nothing, since a pre-1.0 dependency releasing roughly daily may well answer differently by then.

## 6. `buzz-acp` is permanently rejected

This one is architectural, so nothing above — including the sunk-cost correction in §4 — touches it.

`PRODUCT.md` makes the ToS-compliance model _the_ design stance: Shepherd only **observes** (reads the terminal) and **steers** (injects keystrokes), on the operator's own subscription. "If a feature cannot be done by typing into a real terminal, it does not ship." `buzz-acp` inverts all three:

- **Spawn ownership inverts.** buzz spawns the agent (`relay ──WS──→ buzz-acp ──stdio──→ agent`); Shepherd owns the herdr pane. Two orchestrators cannot both own the process.
- **Headless JSON-RPC, no PTY.** ACP is `initialize` / `session/new` / `session/prompt` over stdio. `src/blocked.ts` and the xterm.js viewport (`WS /pty/:id`) have nothing to attach to.
- **Metered-API auth.** The Claude path is `claude-agent-acp` + `ANTHROPIC_API_KEY` — the billing model the design stance exists to avoid.

**`buzz-acp` is an adjacent competitor to Shepherd's core, not a complement.** Adopting it wouldn't integrate Shepherd with buzz; it would replace Shepherd with buzz.

## 7. Reference: buzz's integration surfaces

[block/buzz](https://github.com/block/buzz) (Block Inc., **Apache-2.0**, Rust ~48% / TS ~35%, 3.8k★, created 2026-03-06) is a self-hosted **Nostr relay** presented as a team workspace: every message, reaction, workflow step, patch and git event is a signed event in one log, so humans and agents are indistinguishable at the protocol layer.

**Pre-1.0, moving fast:** `v0.4.22` (2026-07-21); the six most recent tags all landed 2026-07-17…07-21. Weekly commits over six weeks: 105 → 122 → 134 → 141 → 208 → 273. README status: "Not finished." `ARCHITECTURE.md` documents real gaps (approval gates incomplete; `send_dm` and `set_channel_topic` return `NotImplemented`). Docs drift from code — `buzz-acp`'s README documents a `GET /api/channels?member=true` route absent from the relay router. **No compatibility guarantee**, which is the single strongest argument for the generic-only coupling rule in §2.

| Surface           | Contract                                                                                                                                                                         | Auth                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **`buzz-cli`**    | Subprocess; JSON stdout, `{"error","message"}` stderr, exit codes `0 ok / 1 user / 2 network / 3 auth / 4 other / 5 write-conflict`. REST underneath (`POST /events`, `/query`). | `BUZZ_PRIVATE_KEY` (nsec/hex) signing **NIP-98**; `BUZZ_RELAY_URL` |
| **Relay WS/HTTP** | NIP-01 wire format; NIPs 1,2,10,11,16,17,23,25,29,33,38,42,50,56. Custom kind registry (9 chat, 40008 diff, NIP-34 git, 46000+ workflows, 48001 audit).                          | NIP-42 (WS), NIP-98 (HTTP), Blossom BUD-01 (media)                 |
| **Workflows**     | YAML → kind 30620. Triggers `message_posted`/`reaction_added`/`diff_posted`/`schedule`/`webhook`; actions incl. `call_webhook {url, method?, headers?, body?}`.                  | `POST /hooks/{workflow_uuid}` → 202, per-workflow UUID secret      |

**If a Shepherd→buzz bridge is ever built, it is an out-of-repo plugin** (`docs/plugins.md`), needing zero core changes: `ctx.events.subscribe` (`src/plugins/types.ts:117`) → shell out to `buzz-cli`. Two things that will bite:

- **Dedup is the plugin's job.** `EventHub` (`src/events.ts`) is 13 lines, synchronous, untyped, no replay; `session:git` re-fires every poll. Copy the `lastState` + `emitted` + cold-start pattern from `src/pr-opened-telemetry.ts:38-52` and persist cursors in `ctx.state`.
- **Inbound control needs a public HTTPS host.** buzz's `call_webhook` accepts custom `headers` (so `Authorization: Bearer $SHEPHERD_TOKEN` reaches the existing `POST /api/sessions/:id/reply`), but it requires public HTTPS and SSRF-blocks private ranges (`ARCHITECTURE.md`) — Tailscale Funnel is the natural fit given `src/tailscale.ts`, **unverified whether `*.ts.net` passes the filter**. Note the trust asymmetry: that path lets anyone who can post in a channel type into a live agent's terminal. Gate on author pubkey in the workflow `filter`, not a `!steer` prefix.

## Recommendation

1. **No code now**, in this repo or out of it. The solo case needs nothing; the federated case has no date.
2. **When federation gets a date, run the §5 CAS spike first.** It is the Phase-0 gate — it can genuinely discriminate, and its outcome determines whether the substrate conversation includes buzz at all.
3. **Keep the coupling rule from §2** whatever the substrate turns out to be: generic primitives only, Shepherd's domain model stays in Shepherd. Against a dependency shipping daily with no compat guarantee, this is the whole hedge.
4. **A herd-events mirror plugin is defensible but not a priority.** Now that the four-service cost is sunk it is no longer objectionable — it is simply not solving anything, since push already covers notification.
5. **`buzz-acp` is rejected permanently** (§6) — architectural, not economic, so no change in cost or direction reopens it.

## Sources

- [github.com/block/buzz](https://github.com/block/buzz) — README, `ARCHITECTURE.md`, `NOSTR.md`
- `crates/buzz-cli/README.md` (incl. the `mem` group and `--base-hash`), `crates/buzz-acp/README.md`, `crates/buzz-core/src/kind.rs`, `crates/buzz-auth/src/scope.rs`, `crates/buzz-relay/src/{router.rs,nip11.rs,api/bridge.rs}`, `crates/buzz-workflow/src/schema.rs`
- `deploy/compose/README.md`, `deploy/charts/buzz`
- [Agent Client Protocol](https://agentclientprotocol.com)
- Shepherd: `PRD.md`, `PRODUCT.md`, `docs/plugins.md`, `src/{drain-core,repo-roles,events,push,blocked,plugins/types,pr-opened-telemetry,tailscale}.ts`
