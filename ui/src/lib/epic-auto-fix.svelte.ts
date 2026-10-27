import { untrack } from "svelte";
import type {
  DrainStatus,
  EpicAutoBlockers,
  EpicAutoFixOption,
  EpicAutoFixOptionId,
  EpicAutoFixState,
} from "./types";
import { ApiError, applyEpicAutoFix, getEpicAutoFix } from "./api";
import { m } from "#lib/paraglide/messages.js";
import { toasts } from "./toasts.svelte";
import { repoConfig } from "./reviews.svelte";
import { sandboxHaltedEpic } from "./components/epic-panel";

// #3455: an epic's sandbox halt and its auto-fix (#3453) as ONE state per repo, shared by every
// surface that shows it — the run area's halt card (#3454), the epic row's popover / phone sheet
// and the Automation tab's halt count. The model, the operator's pick, an apply in flight and the
// applied fix (Undo) read the same wherever the operator looks. The drain holds at most one epic
// per repo (the leading one), so the repo keys the state and `parent` names the epic it is for.

/** A fix applied here: what it set, what Undo writes back and the children it starts. */
export interface AppliedFix {
  parent: number;
  changes: EpicAutoFixOption["changes"];
  previous: EpicAutoFixState;
  starting: number[];
}

interface RepoFix {
  /** The sandbox-halted epic the model is for; null while nothing halts. */
  parent: number | null;
  /** The hold the model was asked for — a different one asks again. */
  key: string | null;
  blockers: EpicAutoBlockers | null;
  picked: EpicAutoFixOptionId | null;
  busy: boolean;
  fix: AppliedFix | null;
  /** Mounted surfaces watching; the state goes once none is left. */
  users: number;
  /** Bumped by every load and adopt, so an answer that arrives late never overwrites a newer one. */
  seq: number;
}

function failed(msg: string) {
  toasts.info(msg, { alert: true, key: "epic-autofix-fail" });
}

class EpicAutoFixStore {
  #repos = $state<Record<string, RepoFix>>({});

  #entry(repoPath: string): RepoFix {
    if (!this.#repos[repoPath]) {
      this.#repos[repoPath] = {
        parent: null,
        key: null,
        blockers: null,
        picked: null,
        busy: false,
        fix: null,
        users: 0,
        seq: 0,
      };
    }
    // Re-read: the store holds the reactive proxy, not the literal assigned above.
    return this.#repos[repoPath];
  }

  #halted(repoPath: string, parent: number): RepoFix | null {
    const e = this.#repos[repoPath];
    return e?.parent === parent ? e : null;
  }

  /** The model for `parent`'s halt; null unless it is the repo's sandbox-halted epic and the
   *  model has answered. */
  blockers(repoPath: string, parent: number): EpicAutoBlockers | null {
    return this.#halted(repoPath, parent)?.blockers ?? null;
  }

  /** The way the operator picked, null for the model's preselection. */
  picked(repoPath: string, parent: number): EpicAutoFixOptionId | null {
    return this.#halted(repoPath, parent)?.picked ?? null;
  }

  pick(repoPath: string, parent: number, option: EpicAutoFixOptionId | null) {
    const e = this.#halted(repoPath, parent);
    if (e) e.picked = option;
  }

  /** An apply or undo is in flight for the repo. */
  busy(repoPath: string): boolean {
    return this.#repos[repoPath]?.busy ?? false;
  }

  /** The fix applied to `parent`, until Undo or the next fix. */
  applied(repoPath: string, parent: number): AppliedFix | null {
    const fix = this.#repos[repoPath]?.fix;
    return fix?.parent === parent ? fix : null;
  }

  /** Causes that sit in the repo's settings or on this host — the Automation tab's count. */
  repoHalts(repoPath: string): number {
    const causes = this.#repos[repoPath]?.blockers?.causes ?? [];
    return causes.filter((c) => c.scope === "repo" || c.scope === "host").length;
  }

  /** Follow `repoPath`'s drain: ask the model whenever its sandbox hold changes. Call it from an
   *  `$effect` and return its result — the cleanup releases this surface. */
  watch(repoPath: string, drain: DrainStatus | null | undefined): () => void {
    const parent = sandboxHaltedEpic(drain);
    // What the model reads: the hold (its reason names the CLI or profile at fault) and the
    // repo's sandbox, which can change without moving the reason (Codex is checked first).
    const key =
      parent == null
        ? null
        : [parent, drain?.reason, drain?.detail ?? "", repoConfig.sandboxProfileFor(repoPath)].join(
            "|",
          );
    return untrack(() => {
      void repoConfig.ensure(repoPath);
      const e = this.#entry(repoPath);
      e.users++;
      this.#sync(repoPath, e, parent, key);
      return () => this.#release(repoPath, e);
    });
  }

  #sync(repoPath: string, e: RepoFix, parent: number | null, key: string | null) {
    if (key === e.key) return;
    if (parent !== e.parent || key == null) {
      e.blockers = null;
      e.picked = null;
    }
    e.parent = parent;
    e.key = key;
    if (parent == null) e.seq++;
    else this.#load(repoPath, e, parent);
  }

  #load(repoPath: string, e: RepoFix, parent: number) {
    const seq = ++e.seq;
    getEpicAutoFix(repoPath, parent)
      .then((b) => {
        if (seq === e.seq) e.blockers = b;
      })
      .catch(() => {
        // Without the model the surfaces fall back to the drain's hold line. It is asked again
        // once the hold changes, or after every surface left and one comes back.
        if (seq === e.seq) e.blockers = null;
      });
  }

  #adopt(e: RepoFix, blockers: EpicAutoBlockers) {
    e.seq++;
    e.blockers = blockers;
  }

  #release(repoPath: string, e: RepoFix) {
    e.users--;
    if (e.users > 0) return;
    // An effect's rerun releases and watches again in one go: drop only once nobody came back.
    queueMicrotask(() => {
      if (e.users === 0 && this.#repos[repoPath] === e) delete this.#repos[repoPath];
    });
  }

  /** Apply one of the model's ways in one step. `starting` = the children it starts at once.
   *  False (and a toast) when it didn't. */
  async apply(
    repoPath: string,
    parent: number,
    option: EpicAutoFixOptionId,
    starting: number[],
  ): Promise<boolean> {
    const e = this.#halted(repoPath, parent);
    const chosen = e?.blockers?.options.find((o) => o.id === option);
    if (!e || !chosen || e.busy) return false;
    e.busy = true;
    try {
      const result = await applyEpicAutoFix(repoPath, parent, { option });
      this.#adopt(e, result.blockers);
      e.fix = { parent, changes: chosen.changes, previous: result.previous, starting };
      void repoConfig.reload(repoPath);
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // The model moved on (a setting changed meanwhile): show its current ways.
        failed(m.epic_autofix_unavailable());
        this.#load(repoPath, e, parent);
      } else failed(m.epic_autofix_failed());
      return false;
    } finally {
      e.busy = false;
    }
  }

  /** Write the applied fix's previous values back. */
  async undo(repoPath: string, parent: number) {
    const e = this.#repos[repoPath];
    const fix = e?.fix;
    if (!e || fix?.parent !== parent || e.busy) return;
    e.busy = true;
    try {
      const result = await applyEpicAutoFix(repoPath, parent, { restore: fix.previous });
      // Its model only counts while that epic is still the one held.
      if (e.parent === parent) this.#adopt(e, result.blockers);
      e.fix = null;
      void repoConfig.reload(repoPath);
    } catch {
      failed(m.epic_autofix_undo_failed());
    } finally {
      e.busy = false;
    }
  }
}

export const epicAutoFix = new EpicAutoFixStore();
