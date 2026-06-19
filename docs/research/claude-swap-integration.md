# Integration options: claude-swap (multi-account management)

**Summary.** [`claude-swap`](https://github.com/realiti4/claude-swap) is a Python CLI that lets a person switch a machine between several Claude Code accounts without re-logging-in. Its "session mode" mechanism is **mechanically identical to Shepherd's existing per-spawn `CLAUDE_CONFIG_DIR` auth plumbing** — so wiring multi-account selection into Shepherd is a small change, _technically_. The blocker is **not** engineering: it is that programmatic account **rotation to multiply a subscription's allowance** is a sharper version of the still-unresolved R1 ToS question. This doc maps the tool, states the three integration shapes even-handedly, and recommends what (if anything) to build.

> **Not legal advice.** Engineering/compliance reasoning by an AI agent against published Anthropic policy, evaluated **2026-06-19**. Companion to the [ToS position doc](./tos-position-and-auth-paths.md) and the full [ToS compliance audit](./claude-anthropic-tos-compliance-audit.md) — read those for the R1 risk register this builds on. Treat this as a risk map, not a clearance.

---

## 1. What claude-swap is

A multi-account switcher for Claude Code, written in Python 3.12+ (MIT, ~580★ / 59 forks at time of writing, created 2026-01-11, actively pushed — last commit 2026-06-17). Installed via `uv tool install claude-swap` / `pipx`. Source: `src/claude_swap/` — clean module split (`switcher.py`, `session.py`, `oauth.py`, `paths.py`, `macos_keychain.py`, `cli.py`, `tui.py`), with a real test suite (one test file per module).

**CLI surface** (`cswap`):

| Command                                   | Effect                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `cswap --add-account`                     | Enroll the account currently logged into `~/.claude` (backs up its OAuth credentials)                                          |
| `cswap --add-token`                       | Enroll from a raw OAuth token                                                                                                  |
| `cswap --switch` / `--switch-to N\|email` | **Global** swap — rewrites the active credential for _every_ terminal + the VS Code extension                                  |
| `cswap run N\|email`                      | **Session** mode — launch one `claude` bound to account N in _this_ terminal only; other terminals stay on the default account |
| `cswap --list`                            | Show all accounts with live 5h / 7d / spend usage + reset clocks                                                               |
| `cswap --export` / `--import`             | Back up / migrate the account store                                                                                            |

### 1.1 The mechanism (this is the load-bearing finding)

From `session.py`'s own docstring (verbatim):

> `cswap run NUM|EMAIL` launches Claude Code with **`CLAUDE_CONFIG_DIR` pointing at a persistent per-account profile** under `<backup_dir>/sessions/<num>-<email-slug>/` … `CLAUDE_CONFIG_DIR` fully isolates Claude Code's config and credential lookup … Profiles are seeded with a **plaintext `.credentials.json`** — deliberate, including on macOS … the plaintext fallback is Claude's only credential mechanism on Linux (a stable contract).

So a "session" is nothing more exotic than: **a directory holding a `.credentials.json`, selected via the `CLAUDE_CONFIG_DIR` env var at launch.** On Linux (Shepherd's deployment target) credentials are plaintext files — no keychain. Sharing of `~/.claude` customizations (`settings.json`, `keybindings.json`, `CLAUDE.md`, `skills/`, `commands/`, `agents/`) into the profile is done by **symlink**, excluding account-scoped state (`plugins/`, `projects/`, `sessions/`, `.claude.json`, `.credentials.json`).

**This is the same primitive Shepherd already uses.** Shepherd's api-key passthrough (`src/auth-config-dir.ts`) builds a `CLAUDE_CONFIG_DIR` mirror that symlinks all of `~/.claude` _except_ `.credentials.json` and copies `.claude.json`; `src/spawn-auth.ts` sets `CLAUDE_CONFIG_DIR=<mirror>` per spawn. claude-swap's session mode is the _inverse_ of the same trick: a mirror that _includes_ a chosen `.credentials.json`. The two designs converged on the identical mechanism independently.

### 1.2 What it actually owns that Shepherd doesn't

- **OAuth token lifecycle.** `oauth.py` refreshes tokens directly against `https://platform.claude.com/v1/oauth/token` (hardcoded `client_id 9d1c250a-…`, `oauth-2025-04-20` beta header), parsing/writing the `claudeAiOauth` payload (`accessToken` / `refreshToken` / `expiresAt` / `scopes`). It refreshes a profile's token on bootstrap if near expiry.
- **Per-account usage telemetry.** `--list` surfaces 5h / 7d / spend percentages with reset clocks per account — data Shepherd does _not_ currently track per credential (Shepherd's `/usage` is single-account and subscription-only).
- **Concurrency hygiene.** Backup-dir `FileLock`, a deferred "stale credentials" marker so a live session is never yanked out from under a running `claude`, and macOS keychain abstraction (irrelevant on Linux).

---

## 2. Why Shepherd is single-account today

Confirmed against current HEAD:

- Auth is **operator-wide**. `src/spawn-auth.ts` is the single source of truth and reads exactly one `config.authMode` (`subscription` | `api-key`) + one `config.authApiKeyHelperPath`. Every spawn in an instance shares the same credential.
- There is **no** account / rotate / swap concept anywhere in the spawn path. (Grep hits for "account" are billing **spend ceilings** in `config.ts` / `drain-core.ts`, not identities.)
- Per-spawn `CLAUDE_CONFIG_DIR` is already plumbed for api-key mode but always points at the _one_ shared mirror (`~/.shepherd/claude-apikey-config`), not a per-session choice.
- Settings are a simple KV store (`store.getSetting` / `setSetting`); adding a setting is the `SETTING_PATCHES` pattern in `src/server.ts` (validate → live-update `config` → persist).

**Bottom line:** the only thing standing between Shepherd and per-session account selection is _(a)_ a place to store N credential profiles and _(b)_ a selector threaded to each spawn so `CLAUDE_CONFIG_DIR` can point at the chosen profile. Both are small. The mechanism is already in the codebase.

---

## 3. Integration options (even-handed)

### Option A — Shell out to `cswap run` as the launcher

Replace the `claude …` invocation with `cswap run <account> -- …`.

- **Pros:** zero credential code in Shepherd; cswap owns enrollment, refresh, storage.
- **Cons (significant):** `cswap run` _is itself_ the launcher — it builds and execs `claude`. Shepherd builds its argv with surgical precision (the `NODE_COMPILE_CACHE` env shim in `herdr.ts`, the `--settings` JSON fragment from `spawn-auth.ts`, the bwrap membrane). Handing the launch to cswap fights all of that. Adds a **Python runtime dependency** to a bun/TS server. cswap also _scrubs_ `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` from the session env by design — colliding with Shepherd's `apiKeyHelper` footing. **Not recommended:** architectural impedance mismatch.

### Option B — Borrow the technique, natively (no dependency)

Since a "session" is just `CLAUDE_CONFIG_DIR` → a dir with a `.credentials.json`, extend Shepherd's own `auth-config-dir.ts` to manage N profiles and thread a selector through the spawn path. No Python, no external tool.

- **Pros:** stays in-house; reuses the exact primitive already shipped; full argv control retained; composes with both auth footings.
- **Cons:** Shepherd must then own the **hard parts cswap already solved** — OAuth refresh (the direct token-endpoint POST), expiry handling, the enrollment UX, and the stale-credential-while-live guard. The token-refresh path in particular is brittle (hardcoded client id, undocumented endpoint) and a maintenance liability.

### Option C — Hybrid: cswap as the credential _vault_, Shepherd as the _selector_ (recommended shape, IF built at all)

Let `cswap` own enrollment, storage, refresh, and usage telemetry. Its session profiles live at `<backup>/sessions/<n>-<email>/` — **plain directories on disk**. Shepherd simply sets `CLAUDE_CONFIG_DIR` to the chosen profile dir per spawn (it already constructs this env token in `herdr.ts`). No launcher hand-off, no API-key collision, full argv control.

- **Pros:** reuses cswap's hardest, most fragile code (token refresh, usage API) without inheriting its launcher; the coupling surface is a directory path, not a process; degrades gracefully (a missing/expired profile is detectable before spawn).
- **Cons:** still a Python tool on the box (operator-run `cswap --add-account`, not server-invoked); Shepherd must read cswap's on-disk layout (a soft contract that could drift across cswap versions); needs a session→account selector in the UI + a `sessions.accountId` column for audit.

---

## 4. The dominant caveat — ToS (read before any build)

Engineering feasibility is **not** the deciding factor. The [ToS position doc](./tos-position-and-auth-paths.md) establishes that Shepherd's automated puppeting of an interactive subscription (R1) is a _good-faith position, not Anthropic-confirmed_ — no clause blesses keystroke automation, and the metered Agent SDK credit is a strong signal automated work is _meant_ to flow through (and be capped by) that channel.

**Multi-account rotation does not sit beside R1 — it sharpens it.** There is a categorical difference between two use cases the same mechanism enables:

1. **Quota multiplication / rate-limit evasion** — programmatically rotating across N subscriptions so autonomous drain keeps running past one account's 5h/7d cap. This is the textbook circumvention pattern: it doesn't just risk the "automated access" clause (R1), it _defeats the usage limits themselves_. cswap's prominent per-account usage display makes this the path of least resistance. **This is the use case to refuse.** Building rotation-for-throughput would convert R1's "ambiguous, at-risk" posture into a clear fair-use violation, and is squarely contrary to the audit's stance.

2. **Per-identity binding** — a team where different repos/orgs legitimately belong to different Claude accounts, and each session must run as the correct owning identity (not to get _more_ total allowance, but to attribute work correctly). This is defensible in spirit, but still runs each session through R1's unresolved automated-puppeting question, now multiplied across identities — and may implicate the _other_ accounts' owners' consent.

Either way, the clean-compliance answer Shepherd **already ships** for scaling beyond one subscription's limits is **footing (B), api-key / Commercial Terms** (Settings → Session → Auth Mode, since v1.30.0) — where the automation clause does not bite and there is no per-subscription cap to "rotate" around. Multi-subscription rotation is the _non-compliant_ way to get what api-key mode gives compliantly.

---

## 5. Recommendation

1. **Do not build account rotation for quota/throughput.** It turns R1 from an ambiguity into a circumvention, and the compliant scaling path (api-key footing B) already exists. (Recommend, don't merely note — this is the load-bearing call.)
2. **Treat per-identity binding (use case 2) as blocked on the open Anthropic question** (R1 Action 1, tracked on issue #647). It is the only multi-account framing worth revisiting, and only _after_ Anthropic answers whether automated interactive puppeting is permitted at all — multiplying identities before that answer multiplies the risk.
3. **If/when it is ever built,** prefer **Option C** (cswap as vault, Shepherd as `CLAUDE_CONFIG_DIR` selector) — it reuses cswap's fragile token-refresh/usage code without the launcher impedance mismatch, and the coupling is a directory path. Option B (native) only if a Python dependency on the host is unacceptable and Shepherd is willing to own OAuth refresh. Reject Option A.
4. **Harvest the one unambiguously-useful idea now, decoupled from multi-account:** cswap's **per-account usage + reset-clock telemetry** (`oauth.py` usage API) is a nicer surface than Shepherd's current single-account `/usage`. That's a standalone UX improvement that carries none of the ToS baggage and could be lifted regardless.

**The honest verdict:** integration is _easy_ and _tempting_ precisely because the mechanism already lives in Shepherd — and that is the trap. The mechanism's availability says nothing about whether the resulting behavior is permitted. Park multi-account behind the Anthropic answer; the engineering is the last problem, not the first.

---

## Sources

- claude-swap repository (source read at commit of 2026-06-17) — <https://github.com/realiti4/claude-swap>
- Shepherd HEAD: `src/spawn-auth.ts`, `src/auth-config-dir.ts`, `src/auth-mode.ts`, `src/herdr.ts`, `src/server.ts` (settings), `src/config.ts`
- [ToS position & auth paths](./tos-position-and-auth-paths.md) · [ToS compliance audit](./claude-anthropic-tos-compliance-audit.md)
- Anthropic Consumer Terms — <https://www.anthropic.com/legal/terms>

---

_Research deliverable · 2026-06-19 · Engineering + compliance reasoning, not legal advice._
