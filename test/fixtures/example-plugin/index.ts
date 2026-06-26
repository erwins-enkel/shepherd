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

  // Observe the read-only core event stream (just count, for the demo).
  let eventCount = (ctx.state.get<number>("eventCount") ?? 0) as number;
  const unsub = ctx.events.subscribe(() => {
    eventCount += 1;
    ctx.state.set("eventCount", eventCount);
  });

  // Observe spawns and publish a running counter to the status panel. Returns nothing —
  // a template stays a no-op until you decide to mutate the spawn via a SpawnPatch.
  ctx.onSpawn((d: SpawnDescriptor) => {
    const spawns = ((ctx.state.get<number>("spawnCount") ?? 0) as number) + 1;
    ctx.state.set("spawnCount", spawns);
    ctx.log.log(`onSpawn: session=${d.sessionId} repo=${d.repoRoot} spawns=${spawns}`);
    ctx.publishStatus({ spawnCount: spawns, lastSession: d.sessionId, eventCount });
    // return; // a real plugin could `return { env: { CLAUDE_CONFIG_DIR: "/path" } }`
  });

  // A read-only HTTP route under /api/plugins/example-plugin/status.
  ctx.route("GET", "status", () =>
    Response.json({
      spawnCount: ctx.state.get<number>("spawnCount") ?? 0,
      eventCount: ctx.state.get<number>("eventCount") ?? 0,
    }),
  );

  ctx.publishStatus({ spawnCount: ctx.state.get<number>("spawnCount") ?? 0, eventCount });

  return () => {
    unsub();
    ctx.log.log("torn down");
  };
}
