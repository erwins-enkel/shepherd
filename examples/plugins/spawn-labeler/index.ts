// spawn-labeler — a fuller, real-world Shepherd example plugin (issue #1153).
//
// This is the RECOMMENDED copy-me reference. It goes beyond the minimal echo skeleton
// in `test/fixtures/example-plugin/` by exercising the `ctx` seam the way a real plugin
// does: it returns an actual `SpawnPatch` from `onSpawn`, has one route that READS state
// and one that WRITES it, and publishes a non-trivial status payload the Settings →
// Plugins panel renders. See docs/plugins.md → "A fuller example: spawn-labeler".
//
// What it does: stamps every agent Shepherd spawns with a per-repo label env var
// (e.g. SHEPHERD_SPAWN_LABEL=shepherd#3 — "the 3rd agent spawned in the shepherd repo").
// It's a deliberately BENIGN, public-safe analog of the private `claude-swap` plugin's
// env-injection seam — same `onSpawn → { env }` mechanic, no credential logic.
//
// ── Types & portability ──────────────────────────────────────────────────────────────
// This in-repo example imports the contract for type-checking against the real source.
// The `import type` line is ERASED at runtime, so it never affects loading — BUT the
// relative `../../../src/plugins/types` path only resolves inside this repo. When you
// COPY this folder into ~/.shepherd/plugins/ and open/type-check it out-of-repo, that
// path breaks. So on copy, do ONE of:
//   • delete the `import type` line (the entry runs fine untyped), or
//   • vendor `src/plugins/types.ts` into the folder and import from "./types".
// (Same note as the fixture header.)
import type { PluginContext, SpawnDescriptor, SpawnPatch } from "../../../src/plugins/types";

/** Shape of this plugin's own config.json (all fields optional — sensible defaults). */
interface SpawnLabelerConfig {
  /** Env var name to set on each spawn. Default: "SHEPHERD_SPAWN_LABEL". */
  envVar?: string;
  /** Label template. Tokens (all sourced from the SpawnDescriptor — there is no issue
   *  number in the descriptor): {repo} = basename(repoRoot), {n} = per-repo spawn count,
   *  {session} = sessionId. Default: "{repo}#{n}". */
  labelTemplate?: string;
}

/** What we persist for the most recent spawn (powers `GET stats` + the status panel). */
interface LastSpawn {
  sessionId: string;
  repoRoot: string;
  label: string;
  at: string;
}

/** Last path segment of a repo root, e.g. "/home/me/shepherd" → "shepherd". Inlined so
 *  the example carries no `node:path` dependency; falls back to the full root if empty. */
function basename(p: string): string {
  const segs = p.split("/").filter(Boolean);
  return segs[segs.length - 1] ?? p;
}

export function register(ctx: PluginContext): () => void {
  // ── config (ctx.config) ──────────────────────────────────────────────────────────
  // ctx.config is this plugin's own config.json, parsed (or {} when absent). We read it
  // once at register time and fall back to defaults for any missing/blank field.
  const cfg = ctx.config as SpawnLabelerConfig;
  const envVar = typeof cfg.envVar === "string" && cfg.envVar ? cfg.envVar : "SHEPHERD_SPAWN_LABEL";
  const template =
    typeof cfg.labelTemplate === "string" && cfg.labelTemplate ? cfg.labelTemplate : "{repo}#{n}";

  ctx.log.log(`registering — envVar=${envVar} template=${template}`);

  // ── durable state (ctx.state) ────────────────────────────────────────────────────
  // Per-repo spawn counts live in ONE durable key as a { [repo]: count } object, plus a
  // `lastSpawn` record. We seed in-memory copies from state at load so the hot path reads
  // memory, and write back on each spawn (spawns are infrequent, so a state write here is
  // within the single-loop discipline — see docs/plugins.md). `noUncheckedIndexedAccess`
  // makes every index access `T | undefined`, so reads are guarded with `?? …`.
  let repoCounts = ctx.state.get<Record<string, number>>("repoCounts") ?? {};
  let lastSpawn = ctx.state.get<LastSpawn>("lastSpawn");

  const totalSpawns = (): number => Object.values(repoCounts).reduce((a, b) => a + b, 0);

  /** The non-trivial status blob the panel renders verbatim (config in effect + live
   *  totals + per-repo breakdown + last spawn). */
  const publish = (): void =>
    ctx.publishStatus({
      envVar,
      labelTemplate: template,
      totalSpawns: totalSpawns(),
      repos: repoCounts,
      lastSpawn: lastSpawn ?? null,
    });

  // ── the load-bearing capability: onSpawn → SpawnPatch ──────────────────────────────
  // Fires just before each agent launches (create + resume). We increment this repo's
  // count, format the label from DESCRIPTOR FIELDS ONLY, persist, refresh the panel, and
  // RETURN a real patch: an env overlay the agent will see. (A real account-switcher
  // would instead return { credentialDir } / { env: { CLAUDE_CONFIG_DIR } } here.)
  ctx.onSpawn((d: SpawnDescriptor): SpawnPatch => {
    const repo = basename(d.repoRoot);
    const n = (repoCounts[repo] ?? 0) + 1;
    repoCounts = { ...repoCounts, [repo]: n };
    const label = template
      .replaceAll("{repo}", repo)
      .replaceAll("{n}", String(n))
      .replaceAll("{session}", d.sessionId);
    lastSpawn = {
      sessionId: d.sessionId,
      repoRoot: d.repoRoot,
      label,
      at: new Date().toISOString(),
    };

    ctx.state.set("repoCounts", repoCounts);
    ctx.state.set("lastSpawn", lastSpawn);
    ctx.log.log(`labeling session=${d.sessionId} ${envVar}=${label}`);
    publish();

    return { env: { [envVar]: label } };
  });

  // ── routes (ctx.route) — one reads state, one writes it ────────────────────────────
  // GET /api/plugins/spawn-labeler/stats — serves the live counters (reads state).
  ctx.route("GET", "stats", () =>
    Response.json({
      envVar,
      labelTemplate: template,
      totalSpawns: totalSpawns(),
      repos: repoCounts,
      lastSpawn: lastSpawn ?? null,
    }),
  );

  // POST /api/plugins/spawn-labeler/reset — clears the counters (writes state).
  ctx.route("POST", "reset", () => {
    repoCounts = {};
    lastSpawn = null;
    ctx.state.set("repoCounts", repoCounts);
    ctx.state.delete("lastSpawn");
    publish();
    return Response.json({ ok: true, cleared: true });
  });

  // Publish an initial snapshot so the panel has data before the first spawn.
  publish();

  // ── gear-menu item (ctx.publishGearItem) ────────────────────────────────────────────
  // Contribute one item to the top-bar gear menu. Three action kinds are available:
  //
  //   panel  → opens Settings → Plugins, scrolled to this plugin's card (used below).
  //   route  → calls one of this plugin's own routes and toasts the response text:
  //     { kind: "route", method: "GET", path: "stats" }
  //   url    → opens an absolute http/https URL in a new tab:
  //     { kind: "url", href: "https://your-dashboard.example.com" }
  //
  // Additive guard: publishGearItem is absent on older cores — the guard makes the
  // plugin safe across Shepherd versions without a manifest version check.
  if (typeof ctx.publishGearItem === "function") {
    ctx.publishGearItem({ label: "Spawn labeler", icon: "🏷️", action: { kind: "panel" } });
  }

  // Teardown: nothing to unwind (no subscriptions, state already persisted on each spawn).
  return () => ctx.log.log("torn down");
}
