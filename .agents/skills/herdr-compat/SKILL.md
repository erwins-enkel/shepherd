---
name: herdr-compat
description: Use when preparing Shepherd to support a new herdr version, checking herdr compatibility or release readiness (Freigabekontrolle), or investigating an update blocked as unsupported. This prepares Shepherd; it does not update the operator's herdr installation.
---

# Prepare Shepherd for a herdr release

Read and follow the shared repository skill at
[`.claude/skills/herdr-compat/SKILL.md`](../../../.claude/skills/herdr-compat/SKILL.md)
before acting. Resolve that link relative to this file; resolve the shared skill's
repository paths from the repository root. Follow its references, including
`CLAUDE.md` and `.claude/rules/herdr-version-bump.md`, explicitly in Codex.

The shared file owns the workflow for both agents. Use it to prepare and verify
Shepherd's support for the requested version, without updating the operator's
herdr installation or restarting their daemon.
