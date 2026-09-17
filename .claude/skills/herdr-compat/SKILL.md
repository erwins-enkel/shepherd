---
name: herdr-compat
description: Use when preparing Shepherd to support a new herdr version, checking herdr compatibility or release readiness (Freigabekontrolle), or investigating an update blocked as unsupported. This prepares Shepherd; it does not update the operator's herdr installation.
---

# Prepare Shepherd for a herdr release

Make Shepherd compatible with the requested herdr release and produce evidence for
admitting it to the supported range. Invocation examples: `/herdr-compat 0.9.1`
in Claude Code or `$herdr-compat Prepare Shepherd for herdr 0.9.1` in Codex.
The version is an input, never a permanent pin in this skill.

## Read first

Resolve all paths below from this repository's root. Read `CLAUDE.md` and
`.claude/rules/herdr-version-bump.md` explicitly in both agents; Codex must not
depend on Claude's automatic rule loading. The rule owns the compatibility SOP,
bump checklist and history. Reuse `scripts/herdr-compat.ts` and the latest report
under `docs/herdr-compat/`; do not invent a second checker.

## Scope

Change Shepherd's integration, tests, generated artifacts and support declarations
as the evidence requires. Do not install over the operator's herdr binary, invoke
the in-app update/restart/downgrade endpoints, or stop/restart the operator's daemon.
The existing checker may download candidate/baseline binaries into its private
cache and start disposable isolated test servers. That is verification, not an
update of the running installation.

Creating or editing this skill alone does not run a version admission. When invoked
for a compatibility task, complete the following workflow within the user's scope.
An analysis-only request produces findings without raising the ceiling.

## Workflow

1. **Pin the comparison.** Take the candidate from the request. If unspecified,
   identify the latest stable release at `https://github.com/herdrdev/herdr/releases`
   and state the selected version; previews require an explicit request. Read
   `HERDR_LAST_SUPPORTED_VERSION` and `HERDR_LAST_SPAWNABLE_VERSION` in
   `src/herdr-capabilities.ts` and `HERDR_SOCKET_SUPPORTED_PROTOCOLS` in
   `src/config.ts`. Record the original support ceiling as the baseline **before
   any edits**, and retain it for every rerun. Read the candidate's release notes
   and relevant upstream changes using the SOP's integration-surface checklist.

2. **Measure before admitting.** From the repository root, run:

   ```bash
   bun run herdr:compat -- --candidate <candidate> --baseline <original-ceiling>
   ```

   Inspect `docs/herdr-compat/<candidate>.md`: static checks S1–S4 and live probes
   L1–L10 must be accounted for. `--static-only` is useful for preliminary analysis
   but cannot establish support. Exit 0 means no recorded FAIL, not release approval;
   REVIEW and skipped/undetermined probes still need evidence. The script overwrites
   the report on rerun: preserve and reapply human triage after the final full run.

3. **Resolve findings in Shepherd.** Trace changed schemas, CLI flags and behaviours
   to their consumers; fix affected integration paths and add regression coverage.
   Triage each REVIEW in writing with the impact, evidence and decision. If a FAIL
   cannot be resolved and verified, leave the ceiling unchanged and report the
   blocker. The SOP's zero-FAIL gate takes precedence over its phrase "consciously
   accept every FAIL": do not relabel a failure merely to obtain a green report.
   Record unrelated upstream opportunities separately from compatibility work.

4. **Regenerate against the candidate.** Use the verified candidate binary from
   `~/.cache/shepherd/herdr-compat/<candidate>/herdr` (or the exact-version binary
   reused by the checker):

   ```bash
   HERDR_BIN=<candidate-binary> bun run gen:herdr-schema
   bun run gen:herdr-types
   ```

   For `bun run gen:herdr-fixtures`, reuse `startIsolatedServer` from
   `scripts/herdr-compat/isolated-server.ts` with the candidate binary. Populate a
   disposable workspace/pane, pass the returned `server.env` to the fixture process,
   and call `server.stop()` in `finally`. The checker's servers are already stopped
   when it exits. Never run fixture capture with the default socket: it falls back
   to the operator's daemon. Inspect the manifest and skipped-method warnings;
   a successful exit alone does not prove complete capture.

5. **Prepare the support change.** Once full verification has zero FAIL and every
   REVIEW is resolved in writing, walk the SOP's entire bump-PR checklist. Keep
   support and spawn ceilings aligned, admit only individually verified protocol
   numbers, and preserve capability floors. The sandbox-status floor needs the
   separate L7/manual evidence specified in the SOP. Update generated artifacts,
   support docs, the CLI-reference pin/pages and EN/DE feature announcement as
   required there; read the relevant `.claude/rules/` files explicitly for those
   edits. For CLI docs, the generator resolves `herdr` via PATH: use the cached
   candidate directory on that command's PATH instead of replacing the installation.
   Locate tests that treat the candidate as unsupported and move those cases to a
   still-unsupported version while retaining coverage of the block. Update the
   bump history under the SOP when the compatibility task authorizes that guidance
   edit; otherwise include the proposed history entry in the report.

6. **Verify and deliver.** Rerun compatibility checks as needed with the recorded
   original baseline. Run root `bun run lint` and `bun run test`; run UI
   `bun run check` and `bun run test` when UI/catalogs change, plus the applicable
   generated-artifact/docs checks. Use `bun run test`, never bare `bun test`.
   Keep fixes, declarations and the version report together in one reviewable
   change. Creating issues, publishing, merging or deploying is not implied by
   invoking this skill.

## Result

Report the candidate and original baseline, **ready for review** or **blocked**,
the report path, relevant Shepherd changes, check results, and remaining gaps.
Ready requires a full report with zero FAIL, written resolution of every REVIEW,
and the completed bump checklist and applicable checks. Missing live evidence or
unavailable prerequisites means blocked, with support unchanged. Distinguish a
prepared Shepherd change from an already shipped release; confirm that the
operator's herdr installation and running daemon were not updated.
