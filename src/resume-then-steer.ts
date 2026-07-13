/** The seams `resumeThenSteer` needs — a structural subset of both AutopilotDeps and
 *  PlanGateServiceDeps, so either can pass `this.deps` (or an adapter) straight through. */
export interface ResumeThenSteerDeps {
  /** Whether the session's herdr pane is currently a live agent. */
  paneAlive: (id: string) => boolean;
  /** Defer + re-drive first while a herdr-restored account pane still needs it (SessionService.shouldDeferSteer). */
  deferSteer?: (id: string) => boolean;
  /** Resume an exited session so it can be steered (SessionService.resume, async — the awaited
   *  result decides). Truthy resolved value = resumed and steerable. */
  resume: (id: string) => unknown;
  /** Deliver text into the session's live PTY (SessionService.reply). false = didn't land. */
  steer: (id: string, text: string) => Promise<boolean>;
}

/**
 * Deliver `text` to a session, RESUMING an exited (or redrive-pending) pane FIRST so the steer
 * lands on a live agent instead of vanishing. Returns whether the steer landed; a pane that cannot
 * be resumed (resume() resolves falsy) yields false without steering.
 *
 * This is the shared body of autopilot.sendSteer, lifted so the plan gate can deliver reviewer
 * findings the same way. It matters because Claude idles live at its prompt after a turn (a bare
 * steer lands), but Codex EXITS after its turn — so without a resume-first the reviewer's findings
 * would never reach the Codex planner and the plan would never get revised.
 */
export async function resumeThenSteer(
  id: string,
  text: string,
  deps: ResumeThenSteerDeps,
): Promise<boolean> {
  if (!deps.paneAlive(id) || deps.deferSteer?.(id)) {
    // Not live, OR a herdr-restored account husk to re-drive first (Locus B), so the steer lands on
    // the re-driven pane rather than the wrong-account husk. resume() resolves falsy when it can't
    // (archived / no resumable session / a caller-refused provider) — then there's nothing to do.
    if (!(await deps.resume(id))) return false;
  }
  return await deps.steer(id, text);
}
