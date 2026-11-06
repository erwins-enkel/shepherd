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
