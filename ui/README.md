# Shepherd UI

The frontend package for Shepherd: a Svelte 5 SPA on SvelteKit (static adapter) built to `build/` and
served statically by the core server. This is a package-level doc — the [root README](../README.md)
is the front door.

```sh
bun install        # install deps (own lockfile, separate from the root package)
bun run check      # svelte-check + type checks
bun run test       # vitest
bun run check:i18n # locale-catalog parity (EN/DE)
bun run build      # production build to ui/build
```

Design tokens and component recipes live on the `/design-system` route
(`src/routes/design-system/+page.svelte`) — consult it before authoring UI.
