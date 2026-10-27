# Can a local model stand in for JEV? (Laya, Ollama, Kev)

**Verdict: not on this machine, and not yet.** The local route exists — Ollama now serves JEV's
wire format and Shepherd's `Judge` seam already talks to it — but no local model measured here
passes Shepherd's own stop-classifier gate, the operator machine has no memory to spare for one, and
the attempt to measure on its GPU OOM-killed `herdr.service` and with it every running session.
Laya specifically is the wrong model for Shepherd: its context is shorter than Shepherd's prompts.
Keep JEV; the money argument for switching does not exist (§5).

> Research task, **2026-10-26/27**, against `origin/main` at `056ac5bd6`, Ollama `v0.40.11`
> (sha256-verified release tarballs, run from a scratch directory on a private port) and the
> operator's machine: AMD Ryzen AI MAX 385, Radeon 8050S (gfx1151), 32 GB unified memory.
> Prompted by the operator asking to add Laya "next to JEV", with a one-click install, on the
> grounds that an external AI makes no sense if the local hardware can do it. **Report only — this
> document is the entire diff.** It extends [`jev-system-one-models.md`](./jev-system-one-models.md)
> and [`jev-ecosystem-scan.md`](./jev-ecosystem-scan.md).

---

## 0. Which Laya

Two unrelated projects share the name.

- **[`aayushch/laya`](https://github.com/aayushch/laya)** — the link in the request. A desktop
  "notification command center" (Tauri + Svelte shell, Python/FastAPI engine, a bundled n8n
  gateway) that aggregates Slack, Gmail, GitHub, Jira and friends and drafts replies with LLMs it
  _consumes_ (Ollama, LM Studio, or cloud keys via LiteLLM). It exposes no decision API and has no
  component Shepherd could call in place of JEV. Nothing here to build in.
- **[Convai's Laya](https://huggingface.co/convaiinnovations/laya)** — almost certainly what was
  meant: an Apache-2.0, 421M-parameter, non-generative decision model (ModernBERT-large plus a
  decision head) that answers JEV-style `choice` / `noul` / `score` questions, published on
  [Ollama](https://ollama.com/library/laya) as an 844 MB download.

The rest of this document is about the second one, and about local decision models in general.

## 1. The local route exists, and the seam already speaks it

Ollama **v0.35.0** (released 28 Sep) added `POST /v1/systemone`, which its
[release notes](https://github.com/ollama/ollama/releases/tag/v0.35.0) describe as "based on
TypeSafe's Jev API". The [endpoint docs](https://docs.ollama.com/api/systemone.md) match the shapes
`src/judge.ts` is written around: `choice` answers carry `choice`, `probabilities` and `confidence`,
and `noul` answers carry `noul`. It needs no key on a local server.

Measured against a v0.40.11 server on `127.0.0.1:11535`:

- **The `ask` path works unchanged.** `createTypeSafeJudge` (SDK `@typesafe-ai/sdk@0.7.0`, with
  the Bun body shield) given a dummy key and the local base URL got a correct, well-formed `choice`
  answer back from `kev:4b-q4_K_M`. `scripts/eval-stop-classifier.ts --backend jev` runs against
  it with `SHEPHERD_JUDGE_BASE_URL` set and no code change.
- **The key check does not.** `probeTypeSafeKey` calls the SDK's `models.list()`, which expects
  `{ models: [...] }`; Ollama's `GET /v1/models` answers in OpenAI shape (`{ object, data }`). The
  SDK throws `Unexpected response shape from GET /v1/models`, the probe reports `unreachable`, and
  **Settings → Decision model refuses to save a local base URL.**
- **A key is mandatory.** `JudgeSettings.key()` returns null without one and the judge is never
  armed; `KEY_RE` wants 8+ characters. A local backend would need a dummy key today.
- **Spend is mis-priced.** `judgeCostUsd` bills every input token at JEV's $0.042/MTok, so a local
  backend would show phantom spend and could trip the daily ceiling for nothing.

So wiring a local backend is a small change — a keyless mode, a probe that understands a local
server, zero cost — but only worth making once a model is good enough (§2).

## 2. Measured on Shepherd's stop-classifier eval

The gate is the one `jev-system-one-models.md` §9 used: `bun run eval:stop-classifier`, every
gating fixture majority-correct **and** gating accuracy ≥ the pinned `GATING_ACCURACY_FLOOR` of
0.80. JEV cleared it (absolute JEV figures stay unpublished, per that document).

| Model                                                      | Download | Ran on                  | Result                                                                                                                                                                                                                       |
| ---------------------------------------------------------- | -------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`laya:latest`](https://ollama.com/library/laya) (421M)    | 844 MB   | CPU                     | **Cannot run.** Every request is a `400`: _"the prompt is longer than the context length currently available to the model"_. The classifier prompt averages ~850 tokens (67,923 input tokens over 80 calls).                 |
| [`kev:4b-q4_K_M`](https://ollama.com/library/kev)          | 2.7 GB   | CPU (Zen 5, 8C/16T)     | **FAIL.** Gating accuracy 56/65 = 86.2%, but `de-gate-commit` comes back `finished` 9/9 instead of `gate`. Baseline-only `gate-spec-first` → `question` 0/5 (Haiku's known gap too). 80 calls in 348 s, **≈4.4 s per call**. |
| `kev:4b-q4_K_M`                                            | —        | GPU (ROCm 7.2, gfx1151) | **Not measured** — the server was OOM-killed on the first eval request (§4).                                                                                                                                                 |
| [`nimble`](https://ollama.com/library/nimble) (Qwen3.5-9B) | 9.3 GB   | —                       | **Not attempted.** The strongest local option on paper (Bespoke Labs reports it a few points below JEV 1.13), but it would not fit next to the operator's sessions.                                                          |

Laya's own documentation says the same thing the 400 does, more politely. The
[Ollama page](https://ollama.com/library/laya) gives each question "a 512-token budget" covering
instructions, options and state, takes only 2–26 options, and is "English only"; its zero-shot
accuracy on held-out task families is 65.1% against 83.8% in-task. The
[model card](https://huggingface.co/convaiinnovations/laya) is blunter: the base English checkpoint
scores 0.362 zero-shot against 0.318 for random and 0.461 for always-the-majority, and Laya is "a
fast base to specialise, not a zero-shot decision engine". Shepherd's judge sites send 1–4 KB of
terminal tail, task prompt and amendments, often in German. Laya would need both a longer context
and a Shepherd-specific fine-tune before it could be evaluated at all.

Kev's failure is on a German gating fixture, the dimension `jev-system-one-models.md` §7 already
rated a high risk for any decision model. The direction is the cautious one (a `gate` read as
`finished` stalls the session rather than acting), but the gate fails all the same. 4.4 s per call
on CPU also eats most of the default 8 s judge deadline; a GPU would cut that to roughly a second,
but see §3 and §4.

## 3. The machine budget

- **Memory is the binding constraint.** At the start of this test 32 GB were installed, ~14 GB
  available, and ~10 GB already in swap. `herdr.service` alone peaked at 12 GB memory and 4.9 GB swap
  during the session. A resident decision model would compete with agent sessions on every call.
- **The GPU is reachable without root, but only through ROCm.** Ollama's bundled ROCm 7.2 runtime
  detected the Radeon 8050S as gfx1151 (`/dev/kfd` is world-writable). Vulkan is unavailable: no
  Vulkan ICD is installed (`vulkan-radeon` is missing), and installing one needs root.
- **The system Ollama is too old.** `/usr/local/bin/ollama` is v0.23.1, root-owned and run by a
  system unit. `/v1/systemone` needs v0.35.0+, and upgrading needs root.
- **The GPU path needs more memory than the CPU path.** The iGPU has a 512 MB carve-out, so the
  model's GPU buffers come out of system RAM (GTT, 15.3 GiB visible to ROCm). This comes on top of
  the 3.4 GB the server process itself held. That is most likely what tipped an already-swapping
  machine over (§4). The same model had run on the CPU minutes earlier without incident.

## 4. Side finding: one OOM kill takes down every session

This deserves its own issue regardless of the local-model question.

**What happened (2026-10-26 14:51):** the test's `llama-server` ran inside this agent session's
terminal, so it lived in the `herdr.service` cgroup next to every other session. Loading the model
onto the GPU pushed the machine out of memory, and the kernel killed `llama-server` (3.4 GB anon
RSS). `herdr.service` has `OOMPolicy=stop` — systemd's default, which `deploy/herdr.service` does
not override — so systemd then **stopped the whole unit**. Every pane and every agent process went
with it. `Restart=always` brought herdr back five seconds later (14:51:21), but the sessions'
processes were gone.

**Why it matters beyond this test:** anything an agent starts — a test suite, a Vite build, a dev
server, a model — lives in that same cgroup. One kernel OOM kill of any of them is a full outage of
all sessions, not of the one process the kernel chose.

**Worth evaluating:** `OOMPolicy=continue` in `deploy/herdr.service`, so the kernel's victim dies
alone and systemd leaves the unit running. If the victim is herdr itself, `Restart=always` still
recovers as today. That change needs its own verification and is outside this report's scope.

**For any local model server:** it must never run inside `herdr.service`. It needs its own
`systemd --user` unit with `MemoryMax=` so an OOM ends only that unit.

## 5. Cost is not the argument

Shepherd's own `judge_spend` table, 2026-10-20 to 2026-10-26: **1,885 calls for $0.077**. A normal
day is 105–166 calls for ≈$0.005; the busiest day was 1,174 calls for $0.045. That is on the order
of **$2 a year**. A local model saves nothing measurable in money.

The arguments for local that are real:

- **Privacy.** Terminal tails, task prompts and CI logs leave the machine for an early-access vendor.
- **Vendor risk.** JEV is a closed API with a waitlist, per-organisation rate limits and
  snapshot deprecations.
- **Offline operation.**

The arguments against are measured above:

- A **failed quality gate**.
- **Memory** the machine does not have.
- A **root-requiring install** on this host.
- An **outage** when it went wrong.

## 6. What a one-click install would have to be

A button in the web UI cannot run `sudo`, so it cannot upgrade the system Ollama or install a
Vulkan driver. Two shapes are possible:

1. **Shepherd-managed userland Ollama.** Download the release bundle (1.5 GB base plus 1 GB ROCm
   for AMD), verify a pinned sha256 the way the herdr downgrade path does, and run it as its own
   `systemd --user` unit on a private port with `MemoryMax=`. Then `POST /api/pull` the model and
   point the judge at it.
2. **Operator-installed Ollama ≥ 0.35.** Shepherd only checks the version and pulls the model.

Either needs the seam changes from §1, and either must keep the server out of `herdr.service` (§4).
Both are cheap next to the real blocker: there is no model to install yet that passes §2.

## 7. Recommendation

- **Do not build Laya in.** It cannot read Shepherd's prompts, it is English-only, and its own
  authors call it a base to fine-tune.
- **Do not build a local backend now.** No local model passes the stop-classifier gate on this
  machine, and the machine cannot hold one beside its sessions.
- **Keep JEV.** At ~$2 a year, it is not the problem this request assumed.
- **Revisit when** a host has real memory headroom (a 64/128 GB Strix Halo, or a dedicated GPU box
  on the tailnet), **and** a local model passes the recipe below, including the German fixtures.
  At that point the §1 seam gaps and the §6 installer are a small, well-understood follow-up.
- **Separately,** open an issue for `OOMPolicy=continue` on `herdr.service` (§4).

### Reproducing §2

The harness already supports a local backend. Run it on a host with free memory and **outside
`herdr.service`**:

```sh
# Ollama >= 0.35.0 on a private port, in its own memory-limited scope
systemd-run --user --scope -p MemoryMax=8G -- \
  env OLLAMA_HOST=127.0.0.1:11535 OLLAMA_MODELS=$PWD/models ./bin/ollama serve &
OLLAMA_HOST=127.0.0.1:11535 ./bin/ollama pull kev:4b-q4_K_M

# JEV_API_KEY must be non-empty; the local server ignores it
JEV_API_KEY=local-dummy-key SHEPHERD_JUDGE_BASE_URL=http://127.0.0.1:11535 \
  bun run eval:stop-classifier --backend jev --model kev:4b-q4_K_M --json > report.json
```
