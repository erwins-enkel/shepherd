# Example Shepherd plugins

Reference implementations of Shepherd's [server-side plugin system](../../docs/plugins.md).
These are **teaching material** — they are **never auto-loaded** from the repo (Shepherd
only ever scans `~/.shepherd/plugins/`, so the zero-plugin no-op invariant holds). Copy one
into your plugins dir to actually run it.

| Plugin                             | What it shows                                                                                                                                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`spawn-labeler/`](spawn-labeler/) | The recommended copy-me reference: a real `SpawnPatch` from `onSpawn` (injects a per-repo label env var), routes that read/write `state`, a non-trivial `publishStatus` payload, and `config`. |

> For the bare-minimum wiring (manifest + `register` + one route, a pure observer), see
> the skeleton at [`test/fixtures/example-plugin/`](../../test/fixtures/example-plugin/) —
> it's intentionally trivial and exists mainly to back the loader tests.

## Run one

```sh
# 1. Copy the folder into your plugins dir (override the dir with SHEPHERD_PLUGINS_DIR).
cp -r examples/plugins/spawn-labeler ~/.shepherd/plugins/

# 2. Fix the type import for out-of-repo use (see below), then restart Shepherd.
systemctl --user restart shepherd
```

Plugins load **at boot only** — edit the folder, then restart.

### Fix the type import when copying out-of-repo

Each example's `index.ts` imports the plugin contract with a **repo-relative** path
(`../../../src/plugins/types`) so it type-checks against the real source in CI. That
`import type` line is **erased at runtime**, so it never affects loading — but the path
**won't resolve** once the folder lives under `~/.shepherd/plugins/` and you open or
type-check it there. So after copying, do **one** of:

- **delete the `import type … from "…/src/plugins/types"` line** — the entry runs fine
  untyped; or
- **vendor the types**: copy `src/plugins/types.ts` into the folder and import from
  `"./types"`.

See [`docs/plugins.md`](../../docs/plugins.md) for the full plugin API, the `onSpawn`
contract, and a walkthrough of `spawn-labeler`.
