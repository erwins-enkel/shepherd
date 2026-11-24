---
status: accepted
---

# Codex sessions reach the heavy-check slot through PATH shims, not a tool hook

The heavy-check slot is Shepherd's host-wide queue for expensive commands (test suites, builds, type checks), so parallel sessions don't all run them at once (epic #3181). Claude sessions are put behind it by the PreToolUse tool guard, which rewrites a heavy command into the slot runner. When Codex support was added (#3550), Codex had no PreToolUse hook that could rewrite a command, so a Codex session gets PATH shims instead: every tool the guard can classify as heavy (`SLOT_SHIM_TOOLS` in `src/slot-shims.ts`, plus the operator's own heavy commands) gets a tiny `sh` shim in one directory that goes first on the session's PATH. The shim runs `scripts/slot-shim.mjs`, which uses the same classifier (`scripts/tool-guard.mjs` → `isHeavyCommand`) and either goes through the slot or execs the real binary. A shim catches every exec of a shimmed name that goes through PATH, whichever path inside the agent started it.

Codex has since gained a default-on PreToolUse hook that can rewrite Bash and `exec_command` input (`permissionDecision: "allow"` with `updatedInput`). Its documentation warns that "some specialized tool paths can opt out of the default hook path" and calls hooks "a useful guardrail, not a complete enforcement boundary". So the shims stay until a hook-based route has been shown to cover every exec path.

## Consequences

- Two enforcement mechanisms share one classifier. A change to what counts as heavy lands in `scripts/tool-guard.mjs` and applies to both providers.
- A command invoked by absolute path, or a binary not in the shim list, bypasses the slot in a Codex session.
- Names that would shadow `sh`, `bash`, `node` or `env` are never shimmed, even from the operator's custom heavy list.
- If the shim script is not reachable, nothing is shimmed and the session runs unmanaged rather than broken.
- Revisit this decision when Codex's hook is documented to cover every shell and exec path.
