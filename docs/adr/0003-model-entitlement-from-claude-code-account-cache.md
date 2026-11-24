---
status: accepted
---

# Model entitlement is read from Claude Code's own on-disk account cache, failing closed

Some Claude models, Claude Mythos first, are not available to every account: they are granted per organization, and the account's served model catalog marks them `confidential`. Shepherd must offer such a model only when the logged-in account has it, and refuse it before a spawn starts rather than let the CLI fail mid-spawn (#3531). Shepherd answers the question the same way the Claude Code CLI does in its own `isMythosAvailable` (probed against Claude Code 2.1.311): it reads the served model catalog the CLI caches at `<claudeDir>/cache/model-catalog/<orgUuid>-<hash>-cc.json`, counting only the logged-in `oauthAccount.organizationUuid`'s files and taking the newest `fetchedAt`, and only when no such catalog exists falls back to `.claude.json`'s older `additionalModelOptionsCache`. Reading the CLI's own cache keeps Shepherd's answer identical to what the CLI will accept, without a manual operator toggle and without Shepherd making account calls of its own.

## Consequences

- Both files are CLI-internal, so every uncertainty fails closed: a missing or unreadable file, an unknown catalog version or no logged-in org all mean "not available". Hiding a model the account has is recoverable; offering one it lacks is a spawn that dies.
- A Claude Code release that changes the cache layout makes the model disappear from Shepherd until the reader is updated. The probe version above is the one to re-check.
- API-key mode never has an account cache, so such models are always unavailable there.
- An unavailable model is rejected (`422 model_unavailable`, or a typed error for role agents), never rerouted, unlike Fable's `opus[1m]` fallback. Pickers hide it, but keep a saved current value visible.
- Lookups are memoised by file mtime, because `.claude.json` can be megabytes. The logic lives in `src/claude-account-models.ts`.
