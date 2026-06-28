# Example Shepherd plugins

Reference implementations of Shepherd's [server-side plugin system](../../docs/plugins.md).
These are **teaching material** — they are **never auto-loaded** from the repo (Shepherd
only ever scans `~/.shepherd/plugins/`, so the zero-plugin no-op invariant holds). Copy one
into your plugins dir to actually run it.

| Plugin                             | What it shows                                                                                                                                                                                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`spawn-labeler/`](spawn-labeler/) | The recommended copy-me reference: a real `SpawnPatch` from `onSpawn` (injects a per-repo label env var), routes that read/write `state`, a non-trivial `publishStatus` payload, `config`, and a gear-menu item (`publishGearItem`) with a `panel` action. |

> For the bare-minimum wiring (manifest + `register` + one route, a pure observer), see
> the skeleton at [`test/fixtures/example-plugin/`](../../test/fixtures/example-plugin/) —
> it's intentionally trivial and exists mainly to back the loader tests.

## Run one

```sh
# 1. Copy the folder into your plugins dir (override the dir with SHEPHERD_PLUGINS_DIR).
cp -r examples/plugins/spawn-labeler ~/.shepherd/plugins/
# …or symlink it from a checkout so `git pull` keeps the installed plugin current:
ln -s "$PWD/examples/plugins/spawn-labeler" ~/.shepherd/plugins/

# 2. Restart Shepherd to load it. (Optional: fix the type import first — see below —
#    for editor/type-check ergonomics; it is NOT required to run the plugin.)
systemctl --user restart shepherd
```

Plugins load **at boot only** — edit the folder, then restart. A **symlinked** plugin dir
loads identically to a copied one (the loader follows the link).

### Fix the type import for editor/type-check ergonomics (optional)

Each example's `index.ts` imports the plugin contract with a **repo-relative** path
(`../../../src/plugins/types`) so it type-checks against the real source in CI. That
`import type` line is **erased at runtime**, so the plugin **runs fine unfixed** — but
the path **won't resolve** once the folder lives under `~/.shepherd/plugins/`, so your
editor / `tsc` will flag it there. Only if you want clean type-checking out-of-repo,
do **one** of:

- **delete the `import type … from "…/src/plugins/types"` line** — the entry runs fine
  untyped; or
- **vendor the types**: copy `src/plugins/types.ts` into the folder and import from
  `"./types"`.

### Gear-menu item

`spawn-labeler` publishes one item to the top-bar gear menu via `ctx.publishGearItem`:

```ts
ctx.publishGearItem({ label: "Spawn labeler", icon: "🏷️", action: { kind: "panel" } });
```

The three available action kinds are:

- `{ kind: "panel" }` — opens Settings → Plugins, scrolled to this plugin's card.
- `{ kind: "route", method: "GET"|"POST", path: "<route-path>" }` — calls one of the plugin's own routes and toasts the response text.
- `{ kind: "url", href: "https://…" }` — opens an absolute http/https URL in a new tab.

See [`docs/plugins.md`](../../docs/plugins.md) for the full spec (validation rules, all action kinds) and a walkthrough of `spawn-labeler`.
