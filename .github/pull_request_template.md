<!--
Thanks for contributing to Shepherd! See CONTRIBUTING.md for setup and the full
list of quality gates. Keep this PR to one feature, linear off `main`.
-->

## Summary

<!-- What does this change and why? -->

Closes #

## Checklist

- [ ] Conventional-commit PR title (`feat`, `fix`, `chore`, `docs`, …) — enforced in CI.
- [ ] Branch is cut from latest `main` and kept linear (rebase, no merge commits).
- [ ] `bun run lint` and `bun test` pass (and `cd ui && bun run check` + `bun test` when UI is touched).
- [ ] User-facing text routes through the i18n catalogs (`en.json` + `de.json`, parity via `check:i18n`).
- [ ] User-facing feature adds a `ui/src/lib/feature-announcements/entries/*.ts` entry (or `[no-feature-entry]` if none applies).
- [ ] New UI follows the design system (tokens, not literals — see `/design-system`).
- [ ] Docs updated for any changed public API, config, CLI flag, or user-facing behavior.
