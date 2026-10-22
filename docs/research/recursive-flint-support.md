# Should Shepherd support Recursive Flint?

**Verdict: not as a new engine. Flint is a _model_, not a coding CLI, so the cheap path is
"Claude Code with a local Anthropic-compatible endpoint" (Ollama ≥ 0.14 / llama.cpp
`/v1/messages`), not a third `AgentProvider`. Even that is a spike, not a feature: this host
can't run Recursive's own runtime, the only Linux-ready runtime (Ollama) is untested here,
and a single local endpoint serves one generation at a time — the opposite of a herd.**

> Research, **2026-10-22**, one day after Flint's announcement (2026-10-21). Read-only
> research task: this document is the entire diff. Nothing below was run against a live
> Flint model.

---

## 1. What Flint is

| Fact                            | Source text                                                                                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kind                            | "a mixture-of-experts (MoE) model built for fast agentic coding on local hardware" — 40B total, 2.5B active per token                              |
| Context                         | "up to 512k tokens … we recommend staying within 256k tokens"                                                                                      |
| License                         | Weights Apache 2.0 on Hugging Face (`RecursiveSI/flint`); `rec` runtime Apache 2.0 (`recursive-oss/rec`)                                           |
| Harnesses                       | Recursive documents **pi, OpenCode, Cline, OpenHands**. **Claude Code is not mentioned anywhere** in the docs                                      |
| Recursive's own runtime (`rec`) | Apple Silicon only (M4 Pro / M5 Pro / M5 Max, ≥ 48 GB unified). "NVIDIA RTX Spark support for `rec` is coming soon."                               |
| API shape                       | Every documented endpoint is **OpenAI Chat Completions** (`rec` on `:11500/v1`, model `flint`; Ollama `:11434/v1`; llama.cpp `:8080/v1`; vLLM)     |
| Ollama tag                      | `flint:40b-a2b-qat-int4`                                                                                                                           |
| Concurrency                     | `rec`: "The engine handles one generation at a time; overlapping requests can receive HTTP 429."                                                   |
| Hosted                          | Free tier via OpenCode / pi's "Radius" login ("Flint (free, trains on data)"); no public base URL, limits or pricing. Direct API = select partners |

## 2. What Shepherd has today

- Two engines: `AGENT_PROVIDERS = ["claude", "codex"]` (`src/types.ts:20`). Each is a CLI under
  herdr with its own argv builder, resume path, model list, usage/transcript reader and status
  signals (`src/service.ts` `buildSpawnArgv` / `buildCodexSpawnArgv`; `src/codex-*.ts`).
- Adding Codex was `f5c7e3ce2` (#1086, 26 files) **plus at least five follow-ups** (#1091 models,
  #1101 usage, #1930 rollouts, #2832 per-engine defaults, #2945 session ids) — a new engine is a
  months-long tail, not a PR.
- Claude spawns already flow through one auth seam (`src/spawn-auth.ts`, api-key mode via
  `apiKeyHelper` in `--settings`). Nothing sets `ANTHROPIC_BASE_URL`; the sandbox **scrubs**
  `ANTHROPIC_*` from the env (`src/sandbox.ts:315,649`), and autonomous egress allows only
  `ANTHROPIC_EGRESS_HOSTS` (`src/egress.ts:288`).
- Model validation is a closed list (`CLAUDE_MODELS`, `src/types.ts:503`); `src/pricing.ts` has
  only Anthropic rows.

## 3. Options

### A. New engine (`pi` or `opencode` as a 3rd `AgentProvider`) — **no**

Recursive's preferred harness is pi. Supporting it means a third argv/resume/usage/status stack
with no hooks ingestion, mirroring the whole Codex tail above, for one model. Only worth it if
Shepherd wants pi/OpenCode as engines in their own right — a separate product decision, not
"Flint support".

### B. Claude Code → local Anthropic-compatible endpoint — **the only cheap route; spike it**

Claude Code honours `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` (and the
small/fast + subagent model vars). Two documented Flint runtimes speak Anthropic Messages:

- **Ollama ≥ 0.14** ("Ollama provides compatibility with the Anthropic Messages API … including
  tools like Claude Code"; `ANTHROPIC_BASE_URL=http://localhost:11434`). This host has **0.33.3**.
- **llama.cpp server** (`/v1/messages` + token counting).

`rec` itself does **not** (OpenAI only) — a translating proxy (LiteLLM etc.) would be needed.

Everything Shepherd knows about Claude — hooks, transcripts, resume, MCP, status — keeps working,
because the engine is still `claude`. Required Shepherd changes are small and contained:

1. **Endpoint profile** (one setting: base URL + token + model name), injected via the `env`
   block of the `--settings` JSON Shepherd already builds — survives the sandbox env scrub
   without widening it. Route through `spawn-auth.ts` so the "no subscription login visible"
   rule still holds (else Claude's "use custom key?" prompt wedges the pane).
2. **Model validation**: allow the profile's model id past `CLAUDE_MODELS`; skip
   `claude-model-cli` version gates and the Fable fallback for it.
3. **Pricing/usage**: price at $0 (local) and label it, rather than mis-pricing as Sonnet.
4. **Egress**: autonomous netns needs the loopback/host-gateway hole (same mechanism as hook
   ingress via slirp `10.0.2.2`, #711) — or restrict local-model sessions to attended mode.
5. **Scope**: attended task sessions only. Never drain/critic/plan-gate/autopilot by default —
   their quality bar and the cost-guard assumptions (`shepherd-default-model-setting`) were
   tuned on frontier models.

### C. Do nothing now, revisit — **recommended default**

## 4. Why B is still only a spike

- **This host can't run `rec`**: Linux + AMD Strix Halo iGPU (Radeon 8060S), 62 GB RAM with
  ~13 GB free at time of writing. `rec` is Mac-only; Recursive's Linux path is a manual CUDA
  llama.cpp build (NVIDIA only). Ollama on AMD (ROCm/Vulkan) is plausible but **unverified** for
  Flint, and the int4 weights need ~20+ GB resident.
- **Concurrency**: one local endpoint ≈ one generation at a time. Shepherd's value is many
  parallel agents; N sessions on one Flint server queue or 429.
- **Prompt weight**: Claude Code's system prompt + tool schemas + Shepherd's directives are tens
  of thousands of tokens per turn — fine for 256k context, but prefill on an iGPU per turn is the
  likely bottleneck. Third-party guides also report flaky complex tool use / subagents through
  Ollama's Anthropic shim.
- **Fit unproven**: Recursive tuned and evaluated Flint on pi/OpenCode-style harnesses, not
  Claude Code's tool set. A 2.5B-active model driving Shepherd's directive-heavy prompts is an
  open question.
- **Hosted free tier is not usable**: no public base URL, "trains on data", reachable only via
  OpenCode/pi logins.

## 5. Recommendation

1. **Don't add a provider.** Close any "Flint engine" idea unless pi/OpenCode become engines on
   their own merits.
2. **Optional 1-hour manual spike** (no code): `ollama pull flint:40b-a2b-qat-int4`, then in a
   scratch repo
   `ANTHROPIC_BASE_URL=http://localhost:11434 ANTHROPIC_AUTH_TOKEN=ollama ANTHROPIC_MODEL=flint:40b-a2b-qat-int4 claude`.
   Measure: does tool use work, tokens/s and time-to-first-token on this iGPU, does a small fix
   land. Go/no-go for option B hinges on that, not on this report.
3. If the spike is GO: build option B as one PR — "local model endpoint" setting, attended-only,
   $0 pricing, `--settings` env injection — generic (any Ollama/llama.cpp model), with Flint as
   the documented example rather than a Flint-specific integration.

## Sources

- [Introducing Recursive Flint](https://recursive.com/updates/introducing-recursive-flint)
- [Recursive docs — getting started](https://docs.recursive.com/getting-started),
  [rec](https://docs.recursive.com/edge/rec), [Ollama](https://docs.recursive.com/edge/ollama),
  [llama.cpp](https://docs.recursive.com/edge/llama-cpp),
  [NVIDIA/Linux](https://docs.recursive.com/local/nvidia),
  [coding agents](https://docs.recursive.com/guides/coding-agents),
  [pi](https://docs.recursive.com/guides/pi), [API](https://docs.recursive.com/guides/api)
- [recursive-oss/rec](https://github.com/recursive-oss/rec)
- [Ollama — Anthropic compatibility](https://docs.ollama.com/api/anthropic-compatibility),
  [Ollama blog: Claude Code](https://registry.ollama.ai/blog/claude)
- [llama.cpp: Anthropic Messages API](https://huggingface.co/blog/ggml-org/anthropic-messages-api-in-llamacpp)
