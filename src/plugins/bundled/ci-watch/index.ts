// Bundled ci-watch plugin (#2540, epic #2544): failing default-branch CI runs → deterministic
// rules → candidates. Off by default: it loads but every tick is a no-op until the operator
// enables it. Filing comes later (#2541/#2542). Plugin code — reaches core only through `ctx`.

import type { PluginContext } from "../../types";
import { createPoller } from "./poller";

/** Scheduler granularity; the configured poll interval is enforced inside `tick()`. */
const TICK_MS = 60_000;

export default function register(ctx: PluginContext): void {
  const { log } = ctx;
  if (typeof ctx.forge?.runs?.listDefaultBranchRuns !== "function") {
    log.warn("ctx.forge.runs unavailable — ci-watch inert");
    return;
  }
  const poller = createPoller({
    state: ctx.state,
    runs: ctx.forge.runs,
    repos: () => ctx.repos.list(),
    forward: async (c) => {
      log.log(`candidate ${c.workflowName} / ${c.job} (run ${c.runId}) in ${c.repo}`);
      return "candidate";
    },
    now: () => new Date(),
    log,
  });
  ctx.schedule(TICK_MS, () => poller.tick());
}
