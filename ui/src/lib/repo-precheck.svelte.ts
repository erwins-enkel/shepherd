import { untrack } from "svelte";
import type {
  DrainStatus,
  EpicAutoBlockers,
  EpicAutoFixCauseCode,
  EpicAutoFixOption,
  EpicAutoFixOptionId,
  EpicAutoFixState,
} from "./types";
import { ApiError, applyEpicAutoFix, getEpicAutoFix } from "./api";
import { m } from "#lib/paraglide/messages.js";
import { toasts } from "./toasts.svelte";
import { repoConfig } from "./reviews.svelte";

// #3456: the repo overview's pre-check — the auto-fix model (#3453) of every epic it lists, the
// leader as well as queued and not-started ones, asked without starting any. One per overview:
// the shared epicAutoFix store holds only the epic the drain holds, this needs them all. Fixes
// applied here write the server; the other surfaces re-ask through their own keys (the repo's
// sandbox reloads, the drain's kick moves its status).

/** A fix applied from the overview: where it was applied, what it set and what Undo writes back. */
export interface OverviewFix {
  /** The banner (the repo's ways) or the epic's card. */
  at: "repo" | "epic";
  parent: number;
  changes: EpicAutoFixOption["changes"];
  previous: EpicAutoFixState;
}

function failed(msg: string) {
  toasts.info(msg, { alert: true, key: "epic-autofix-fail" });
}

export class RepoPrecheck {
  #models = $state.raw<Readonly<Record<number, EpicAutoBlockers>>>({});
  #busy = $state(false);
  #applied = $state<OverviewFix | null>(null);
  #repo: string | null = null;
  #parents: number[] = [];
  #key: string | null = null;
  /** Bumped by every load, so an answer that arrives late never overwrites a newer one. */
  #seq = 0;

  /** Each listed epic's model by parent; an epic whose model failed to load is missing. */
  get models(): Readonly<Record<number, EpicAutoBlockers>> {
    return this.#models;
  }

  /** A fix or Undo is in flight. */
  get busy(): boolean {
    return this.#busy;
  }

  /** The last fix applied here, until Undo or the next fix. */
  get applied(): OverviewFix | null {
    return this.#applied;
  }

  /** Follow `parents` of `repoPath`: ask every model again whenever the list, the drain's hold or
   *  the repo's sandbox changes. Call it from an `$effect`. */
  watch(repoPath: string, parents: readonly number[], drain: DrainStatus | null | undefined) {
    const key = [
      repoPath,
      parents.join(","),
      drain?.epicParent ?? "",
      drain?.reason ?? "",
      drain?.detail ?? "",
      repoConfig.sandboxProfileFor(repoPath),
    ].join("|");
    untrack(() => {
      void repoConfig.ensure(repoPath);
      if (key === this.#key) return;
      if (repoPath !== this.#repo) {
        this.#models = {};
        this.#applied = null;
      }
      this.#key = key;
      this.#repo = repoPath;
      this.#parents = [...parents];
      void this.#load();
    });
  }

  /** Ask every listed epic's model at once and publish them together, so counts don't flicker. */
  async #load() {
    const seq = ++this.#seq;
    const repo = this.#repo;
    const parents = this.#parents;
    if (repo == null || parents.length === 0) {
      this.#models = {};
      return;
    }
    const answers = await Promise.allSettled(parents.map((p) => getEpicAutoFix(repo, p)));
    if (seq !== this.#seq) return;
    const models: Record<number, EpicAutoBlockers> = {};
    answers.forEach((a, i) => {
      if (a.status === "fulfilled") models[parents[i]!] = a.value;
    });
    this.#models = models;
  }

  /** Apply one cause's own fix through `parent`: the repo's sandbox (at the banner) or the
   *  epic's CLI (at its card). False (and a toast) when it didn't. */
  applyCause(parent: number, code: EpicAutoFixCauseCode, at: OverviewFix["at"]): Promise<boolean> {
    const fix = this.#models[parent]?.causes.find((c) => c.code === code)?.fix;
    if (!fix) return Promise.resolve(false);
    return this.#apply(parent, { cause: code }, fix.changes, at);
  }

  /** Apply one of `parent`'s ways from the banner's chooser. */
  applyOption(parent: number, option: EpicAutoFixOptionId): Promise<boolean> {
    const chosen = this.#models[parent]?.options.find((o) => o.id === option);
    if (!chosen) return Promise.resolve(false);
    return this.#apply(parent, { option }, chosen.changes, "repo");
  }

  async #apply(
    parent: number,
    body: { cause: EpicAutoFixCauseCode } | { option: EpicAutoFixOptionId },
    changes: EpicAutoFixOption["changes"],
    at: OverviewFix["at"],
  ): Promise<boolean> {
    const repo = this.#repo;
    if (repo == null || this.#busy) return false;
    this.#busy = true;
    try {
      const result = await applyEpicAutoFix(repo, parent, body);
      this.#applied = { at, parent, changes, previous: result.previous };
      return true;
    } catch (err) {
      // 409: the model moved on (a setting changed meanwhile); the reload shows its current ways.
      failed(
        err instanceof ApiError && err.status === 409
          ? m.epic_autofix_unavailable()
          : m.epic_autofix_failed(),
      );
      return false;
    } finally {
      this.#busy = false;
      this.#refresh(repo);
    }
  }

  /** Write the applied fix's previous values back. */
  async undo() {
    const fix = this.#applied;
    const repo = this.#repo;
    if (!fix || repo == null || this.#busy) return;
    this.#busy = true;
    try {
      await applyEpicAutoFix(repo, fix.parent, { restore: fix.previous });
      this.#applied = null;
    } catch {
      failed(m.epic_autofix_undo_failed());
    } finally {
      this.#busy = false;
      this.#refresh(repo);
    }
  }

  /** A write changed the repo's sandbox or an epic's CLI: every model may have moved. */
  #refresh(repo: string) {
    void repoConfig.reload(repo);
    void this.#load();
  }
}
