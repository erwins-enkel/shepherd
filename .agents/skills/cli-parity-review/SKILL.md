---
name: cli-parity-review
description: Use when reviewing Codex and Claude Code CLI releases, changelogs, new capabilities, integration regressions, or feature parity in Shepherd, including the daily CLI parity schedule.
---

# CLI parity review

Read and follow the shared repository skill at
[`.claude/skills/cli-parity-review/SKILL.md`](../../../.claude/skills/cli-parity-review/SKILL.md),
including its review contract. Resolve this link relative to this file and repository paths
from the repository root. Read `CLAUDE.md` explicitly; do not depend on Claude's rule loading.

Invoke with `$cli-parity-review` or `$cli-parity-review dry-run`. Dry run is read-only and must
not publish issues, comments, labels or checkpoint updates. A manual Codex invocation ends with
a text report; it does not use `schedule_noop`. The shared skill owns the entire review workflow.
