// Bundled ci-watch plugin (#2540, epic #2544): failing default-branch CI runs → deterministic
// rules → candidates → classification (#2541: flake probe, JEV, triage) → `ci-failure` issues +
// lifecycle sync (#2542). Off by default: it loads but every tick is a no-op until the operator
// enables it. Plugin code — reaches core only through `ctx`.

import type { PluginContext } from "../../types";
import { createClassifier, registerClassifyRoutes } from "./classify";
import { createFiler, type FileFn } from "./file";
import { createPoller } from "./poller";
import { readSettings } from "./state";
import { syncFiled } from "./sync";

/** Scheduler granularity; the configured poll interval is enforced inside `tick()`. */
const TICK_MS = 60_000;

export default function register(ctx: PluginContext): void {
  const { log } = ctx;
  if (typeof ctx.forge?.runs?.listDefaultBranchRuns !== "function") {
    log.warn("ctx.forge.runs unavailable — ci-watch inert");
    return;
  }
  const canFile =
    typeof ctx.issues?.create === "function" && typeof ctx.sessions?.list === "function";
  if (!canFile) log.warn("ctx.issues / ctx.sessions unavailable — ci-watch won't file issues");
  const file: FileFn = canFile
    ? createFiler({
        state: ctx.state,
        issues: ctx.issues,
        runs: ctx.forge.runs,
        repos: () => ctx.repos.list(),
        now: () => new Date(),
        log,
      })
    : async () => null;
  const stage = createClassifier({
    state: ctx.state,
    runs: ctx.forge.runs,
    judge: typeof ctx.judge?.choice === "function" ? ctx.judge : null,
    agents: ctx.agents,
    file,
    now: () => new Date(),
    log,
  });
  const poller = createPoller({
    state: ctx.state,
    runs: ctx.forge.runs,
    repos: () => ctx.repos.list(),
    forward: (c) => stage.process(c),
    sync: async () =>
      canFile
        ? syncFiled({
            state: ctx.state,
            issues: ctx.issues,
            sessions: ctx.sessions,
            now: () => new Date(),
            log,
          })
        : {},
    now: () => new Date(),
    log,
  });
  registerClassifyRoutes(ctx, stage);
  ctx.schedule(TICK_MS, async () => {
    await poller.tick();
    if (readSettings(ctx.state).enabled) await stage.advance();
  });
}
