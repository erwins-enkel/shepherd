# iOS ↔ PWA parity issues

The iOS app lags the PWA, so every PWA change raises the question of what iOS needs.
`.github/workflows/ios-parity.yml` turns that into GitHub issues labelled `parity`,
`ios-app` and `requires-macos`. All logic lives in `scripts/ios-parity.ts`.

- **New PWA feature → one issue.** A push to `main` that adds a What's-New catalog
  entry (`ui/src/lib/feature-announcements/entries/`) opens `iOS-Parität: <title>`
  with the DE/EN catalog text, the source PR and a decision checklist. The entry is
  already mandatory for every user-facing `feat`, so nothing extra is declared.
- **Other PWA changes → weekly digest.** Every Monday, one issue lists the past seven
  days' `ui/src` commits that added no catalog entry (skipping `docs`, `test`, `ci`
  and `build` commits).
- **Backlog → one-time catch-up.** `bun scripts/ios-parity.ts backfill` lists every
  existing catalog feature in issues of up to 90 features, grouped by release line,
  and links them as sub-issues of an `Epic: iOS ↔ PWA Feature-Parität`.

Each issue carries an `<!-- ios-parity:… -->` marker, so re-runs never duplicate.
Every mode takes `--dry-run`. The workflow's manual dispatch can rerun the digest or a
`features` range.

A user-facing feature merged as `fix:` gets no catalog entry and therefore no
feature issue. It only appears in the weekly digest.

## Working the issues

Two stages, so only real iOS work costs a Mac session:

1. **Triage, daily.** A Shepherd schedule runs the repo skill `/ios-parity-triage`
   (`.claude/skills/ios-parity-triage/SKILL.md`). Each run makes up to 20 decisions: feature
   issues first (oldest first), then unchecked digest lines, then unchecked backlog lines (newest
   release line first). It reads the source PR and searches the iOS code under `native/`:
   - **iOS already has it** → comment with the iOS file as evidence, close as completed.
   - **No iOS surface** (server-only, desktop-only, PWA plumbing) → comment with the reason,
     close as not planned.
   - **iOS needs it** → comment with an implementation brief, add `shepherd:auto`.
   - **Product question** → comment with the question and what building it would mean, add
     `parity:decide`.

   Backlog and digest lines are ticked with a short note. A line that needs work or a decision
   gets its own `parity` issue, linked from the line. A collection issue with every line ticked is
   closed, and the epic closes with the last backlog issue. The run closes itself
   (`schedule_noop`) unless a write failed or was rate-limited. `/ios-parity-triage dry-run`
   reports without changing anything.

2. **Implementation, auto-drain.** Issues with `shepherd:auto` are worked one at a time by the
   repo's auto-drain. Their `requires-macos` label sends each one to a connected Mac with Xcode
   (see [machines](../../docs/machines.md#epic-children-on-another-machine)). The PR goes through
   critic and merge like any task and closes the issue.

**Answering a product question.** Filter issues by `parity:decide`. Yes: remove
`parity:decide` and add `shepherd:auto`. The triage comment is the brief the drain session
reads. No: close the issue with a one-line reason.

**Schedule settings.** In the repo's **Repo settings → Schedules**: prompt
`/ios-parity-triage`, daily at 08:00 server time (after the Monday digest), agent Claude
(needed for `schedule_noop`), autopilot on, plan gate off, research off, default model and
effort. Recommended usage limit: up to 80 %, skip when exceeded. Auto-drain must be on for the
repo, with the drain label `shepherd:auto`.
