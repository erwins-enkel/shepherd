// Bundled ci-watch plugin (#2540, epic #2544): failing default-branch CI runs → deterministic
// rules → candidates → classification (#2541: flake probe, JEV, triage). Off by default: it loads
// but every tick is a no-op until the operator enables it. Filing comes later (#2542). Plugin
// code — reaches core only through `ctx`.

import type { PluginContext } from "../../types";
import { createClassifier, registerClassifyRoutes } from "./classify";
import { createPoller } from "./poller";
import { readSettings } from "./state";

/** Scheduler granularity; the configured poll interval is enforced inside `tick()`. */
const TICK_MS = 60_000;

export default function register(ctx: PluginContext): void {
  const { log } = ctx;
  if (typeof ctx.forge?.runs?.listDefaultBranchRuns !== "function") {
    log.warn("ctx.forge.runs unavailable — ci-watch inert");
    return;
  }
  const stage = createClassifier({
    state: ctx.state,
    runs: ctx.forge.runs,
    judge: typeof ctx.judge?.choice === "function" ? ctx.judge : null,
    agents: ctx.agents,
    now: () => new Date(),
    log,
  });
  const poller = createPoller({
    state: ctx.state,
    runs: ctx.forge.runs,
    repos: () => ctx.repos.list(),
    forward: (c) => stage.process(c),
    now: () => new Date(),
    log,
  });
  registerClassifyRoutes(ctx, stage);
  ctx.schedule(TICK_MS, async () => {
    await poller.tick();
    if (readSettings(ctx.state).enabled) await stage.advance();
  });
}
