// Example Shepherd plugin — a generic "echo/status" demo. It doubles as the public
// "hello world" template: copy this folder into ~/.shepherd/plugins/ and edit. It is a
// pure OBSERVER (its onSpawn returns nothing), so it is always safe to load.
//
// Types: this in-repo fixture imports the contract for type-checking. An out-of-repo
// plugin can drop the `import type` line (entry runs untyped) or vendor the type defs —
// the import is erased at runtime, so it never affects loading. See docs/plugins.md.
import type { PluginContext, SpawnDescriptor } from "../../../src/plugins/types";

export function register(ctx: PluginContext): () => void {
  ctx.log.log(`registering (config keys: ${Object.keys(ctx.config).join(", ") || "none"})`);

  // Counters live IN MEMORY (seeded from durable state at load). The core event stream is
  // high-frequency, so the subscriber must NOT do blocking I/O per event — that would stall
  // the single server loop (see docs/plugins.md → "single-loop discipline"). We persist
  // lazily: on teardown for eventCount, and only on the low-frequency onSpawn for spawnCount.
  let eventCount = ctx.state.get<number>("eventCount") ?? 0;
  let spawnCount = ctx.state.get<number>("spawnCount") ?? 0;

  // Observe the read-only core event stream — memory-only increment, no I/O.
  const unsub = ctx.events.subscribe(() => {
    eventCount += 1;
  });

  // Observe spawns (rare) and publish a running counter to the status panel. Returns
  // nothing — a template stays a no-op until you decide to mutate the spawn via a
  // SpawnPatch. Persisting spawnCount here is fine: spawns are infrequent.
  ctx.onSpawn((d: SpawnDescriptor) => {
    spawnCount += 1;
    ctx.state.set("spawnCount", spawnCount);
    ctx.log.log(`onSpawn: session=${d.sessionId} repo=${d.repoRoot} spawns=${spawnCount}`);
    ctx.publishStatus({ spawnCount, lastSession: d.sessionId, eventCount });
    // return; // a real plugin could `return { env: { CLAUDE_CONFIG_DIR: "/path" } }`
  });

  // A read-only HTTP route under /api/plugins/example-plugin/status — serves the live
  // in-memory counters (no state read needed).
  ctx.route("GET", "status", () => Response.json({ spawnCount, eventCount }));

  ctx.publishStatus({ spawnCount, eventCount });

  return () => {
    unsub();
    ctx.state.set("eventCount", eventCount); // persist once, lazily, at shutdown
    ctx.log.log("torn down");
  };
}
