/**
 * Readiness greenfield profile (#3107) — I/O + cache. Gathers the inputs for
 * `greenfield-core.ts` (ecosystem scan, pinned-stack section, docs, forge settings, default-branch
 * runs), caches the report per repo and feeds the red must-haves to the bootstrap drain gate.
 *
 * Runs on its own while a repo is in `active` bootstrap: on entering it, on a cold or stale read
 * from the drain, and after every merged PR in the repo (fast-forwarding the local checkout first,
 * so the scan sees what landed). Reaching the exit predicate flips the repo to `done`.
 *
 * #3411: a bootstrap session's merge does not advance the phase by itself — the advance is held
 * until the default branch's CI after the merge is green (`postMergeCi`), resolved on each scan.
 */
import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BOOTSTRAP_LAST_PHASE,
  READINESS_PENDING,
  type BootstrapSessionPhase,
  type PostMergeCi,
  bootstrapExitReached,
  heldAdvanceTarget,
  phaseAfterBootstrapMerge,
  postMergeCi,
} from "./bootstrap";
import type { GitForge, ForgeRun } from "./forge/types";
import { buildGreenfieldReport, type GreenfieldReport } from "./greenfield-core";
import { fastForwardDefaultBranch, fetchRemoteHead, resolveDefaultBranch } from "./pull";
import { scanEcosystem } from "./readiness";
import { forgeReadiness } from "./readiness-forge";
import type { ForgeReadiness } from "./readiness-forge-core";
import type { SessionStore } from "./store";

/** A cached report older than this is re-read on the next drain read of an active repo. */
const STALE_MS = 10 * 60_000;
/** Minimum spacing of drain-triggered (lazy) refreshes per repo — bounds forge calls on errors. */
const LAZY_MIN_GAP_MS = 60_000;

const PINNED_STACK_RE = /^## Pinned stack\s*$/m;

async function nonEmptyDir(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).some((n) => !n.startsWith("."));
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The first of `dirs` (non-empty) or `files` (present), relative to `dir`, as evidence. */
async function firstDoc(dir: string, dirs: string[], files: string[] = []): Promise<string[]> {
  for (const d of dirs) if (await nonEmptyDir(join(dir, d))) return [`${d}/`];
  for (const f of files) if (await exists(join(dir, f))) return [f];
  return [];
}

async function pinnedStackDoc(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const f of ["CLAUDE.md", "AGENTS.md"]) {
    const text = await readFile(join(dir, f), "utf8").catch(() => "");
    if (PINNED_STACK_RE.test(text)) out.push(f);
  }
  return out;
}

async function readForge(
  dir: string,
  forge: GitForge | null,
  autoLabel: string,
): Promise<ForgeReadiness | "error"> {
  try {
    return await forgeReadiness(dir, forge, autoLabel);
  } catch (e) {
    console.warn(`[greenfield] forge settings read failed repo=${dir}:`, e);
    return "error";
  }
}

/** Default-branch runs; null when the forge can't list them, [] when the read failed. */
async function readRuns(forge: GitForge | null): Promise<ForgeRun[] | null> {
  if (!forge?.listDefaultBranchRuns) return null;
  try {
    return await forge.listDefaultBranchRuns({});
  } catch (e) {
    console.warn("[greenfield] default-branch runs read failed:", e);
    return [];
  }
}

export interface GreenfieldDeps {
  store: Pick<
    SessionStore,
    | "getRepoBootstrap"
    | "setRepoBootstrap"
    | "getRepoConfig"
    | "setBootstrapCiPending"
    | "getBootstrapCiPending"
    | "setBootstrapCiPendingSha"
    | "listActiveRepoBootstraps"
  >;
  resolveForge: (dir: string) => GitForge | null;
  /** The gate's inputs changed (must-haves, a held advance's CI, or the repo reached `done`) —
   *  kick the drain. */
  onChange?: (dir: string) => void;
  /** A bootstrap session's merge advanced the phase (#3112) — propose the next step. */
  onAdvance?: (dir: string, phase: number, sessionId: string) => void;
  /** Fast-forward the local default-branch checkout and answer the branch's remote tip (null when
   *  unknown); injectable for tests. */
  pull?: (dir: string, forge: GitForge | null) => Promise<string | null>;
  now?: () => number;
}

async function defaultPull(dir: string, forge: GitForge | null): Promise<string | null> {
  const branch = await resolveDefaultBranch(dir, {
    forgeDefault: forge ? () => forge.defaultBranch().catch(() => null) : undefined,
  });
  if (!branch) return null;
  const r = await fastForwardDefaultBranch(dir, branch);
  if (r.ok) return r.sha;
  console.warn(`[greenfield] fast-forward skipped repo=${dir} reason=${r.reason}`);
  return fetchRemoteHead(dir, branch);
}

export class GreenfieldService {
  #cache = new Map<string, GreenfieldReport>();
  #inflight = new Map<string, Promise<GreenfieldReport>>();
  #lazyAt = new Map<string, number>();
  /** The last CI verdict of each repo's held advance (#3411). */
  #ciHold = new Map<string, Exclude<PostMergeCi, "green">>();
  #now: () => number;

  constructor(private deps: GreenfieldDeps) {
    this.#now = deps.now ?? Date.now;
  }

  cached(dir: string): GreenfieldReport | null {
    return this.#cache.get(dir) ?? null;
  }

  /** Re-scan now (single-flight per repo). */
  refresh(dir: string): Promise<GreenfieldReport> {
    const running = this.#inflight.get(dir);
    if (running) return running;
    const p = this.#scan(dir).finally(() => this.#inflight.delete(dir));
    this.#inflight.set(dir, p);
    return p;
  }

  /** The red must-haves for the bootstrap gate. Only an `active` repo is scanned; a cold cache
   *  answers {@link READINESS_PENDING} (fail-closed) and starts a scan, a stale one re-scans. */
  mustHavesMissing(dir: string): string[] {
    const hit = this.#cache.get(dir);
    const b = this.deps.store.getRepoBootstrap(dir);
    if (b.state !== "active") return hit?.mustHavesMissing ?? [];
    // A held advance (#3411) waits on CI — re-read it at the lazy-refresh pace.
    const stale = b.ciPendingAt != null ? LAZY_MIN_GAP_MS : STALE_MS;
    if (!hit || this.#now() - hit.checkedAt > stale) this.#lazyRefresh(dir);
    return hit ? [...hit.mustHavesMissing] : [READINESS_PENDING];
  }

  /** The CI verdict holding `dir`'s phase advance (#3411); null when no advance is held. */
  ciHold(dir: string): Exclude<PostMergeCi, "green"> | null {
    if (this.deps.store.getRepoBootstrap(dir).ciPendingAt == null) return null;
    return this.#ciHold.get(dir) ?? "waiting";
  }

  /** Re-anchor and re-scan every active repo with a held advance (#3411) — its CI moves, and main
   *  may move, without a merge Shepherd saw. */
  async refreshPending(): Promise<void> {
    const held = this.deps.store.listActiveRepoBootstraps().filter((r) => r.ciPendingAt != null);
    for (const { repoPath } of held) {
      await this.#pullAndAnchor(repoPath, this.deps.resolveForge(repoPath));
      await this.refresh(repoPath).catch((e: unknown) =>
        console.warn(`[greenfield] scan failed repo=${repoPath}:`, e),
      );
    }
  }

  /** Pull what landed; while an advance is held, anchor it on the branch's tip (#3411). */
  async #pullAndAnchor(dir: string, forge: GitForge | null): Promise<void> {
    const sha = await (this.deps.pull ?? defaultPull)(dir, forge).catch((e: unknown) => {
      console.warn(`[greenfield] fast-forward failed repo=${dir}:`, e);
      return null;
    });
    if (sha) this.deps.store.setBootstrapCiPendingSha(dir, sha);
  }

  /** A PR merged in `dir`: in an active bootstrap, a bootstrap session's PR (#3110: P1+P2 → 3,
   *  P3 → 4) holds the advance until the post-merge CI is green (#3411) — or advances at once when
   *  the forge can't list runs. Then pull what landed and re-scan (which resolves the hold). */
  async onMerged(
    dir: string,
    bootstrapPhase?: BootstrapSessionPhase | null,
    sessionId = "",
  ): Promise<void> {
    const b = this.deps.store.getRepoBootstrap(dir);
    if (b.state !== "active") return;
    // A second sighting of the held merge (poller + "merged" archive) never re-arms it.
    const seen =
      b.ciPendingAt != null && this.deps.store.getBootstrapCiPending(dir)?.sessionId === sessionId;
    const next = bootstrapPhase && !seen ? phaseAfterBootstrapMerge(b, bootstrapPhase) : null;
    const forge = this.deps.resolveForge(dir);
    if (next != null && forge?.listDefaultBranchRuns) {
      this.deps.store.setBootstrapCiPending(dir, this.#now(), sessionId);
      this.#ciHold.delete(dir);
      console.log(`[greenfield] bootstrap phase ${b.phase} → ${next} held for CI repo=${dir}`);
      this.deps.onChange?.(dir);
    } else if (next != null) this.#advance(dir, b.phase, next, sessionId);
    await this.#pullAndAnchor(dir, forge);
    await this.refresh(dir);
  }

  #advance(dir: string, from: number, to: number, sessionId: string): void {
    this.deps.store.setRepoBootstrap(dir, { state: "active", phase: to });
    this.#ciHold.delete(dir);
    console.log(`[greenfield] bootstrap phase ${from} → ${to} repo=${dir}`);
    this.deps.onChange?.(dir);
    this.deps.onAdvance?.(dir, to, sessionId);
  }

  /** Resolve a held advance (#3411) against the scanned runs: green (or a forge without runs)
   *  advances; otherwise the verdict is kept for the checklist. */
  #resolveHold(dir: string, runs: ForgeRun[] | null): void {
    const b = this.deps.store.getRepoBootstrap(dir);
    if (b.state !== "active" || b.ciPendingAt == null) return;
    const to = heldAdvanceTarget(b);
    const held = this.deps.store.getBootstrapCiPending(dir);
    const verdict = runs == null ? "green" : postMergeCi(runs, held?.sha ?? null);
    if (verdict === "green") {
      if (to != null) this.#advance(dir, b.phase, to, held?.sessionId ?? "");
      return;
    }
    const prev = this.#ciHold.get(dir) ?? "waiting";
    this.#ciHold.set(dir, verdict);
    if (verdict !== prev) {
      console.log(`[greenfield] held bootstrap advance: CI ${verdict} repo=${dir}`);
      this.deps.onChange?.(dir);
    }
  }

  #lazyRefresh(dir: string): void {
    const now = this.#now();
    if (now - (this.#lazyAt.get(dir) ?? -Infinity) < LAZY_MIN_GAP_MS) return;
    this.#lazyAt.set(dir, now);
    this.refresh(dir).catch((e: unknown) =>
      console.warn(`[greenfield] scan failed repo=${dir}:`, e),
    );
  }

  async #scan(dir: string): Promise<GreenfieldReport> {
    const forge = this.deps.resolveForge(dir);
    const autoLabel = this.deps.store.getRepoConfig(dir).autoLabel;
    const [doc, prd, design, decisions, forgeState, runs] = await Promise.all([
      pinnedStackDoc(dir),
      firstDoc(dir, ["docs/prd"], ["docs/prd.md", "PRD.md"]),
      firstDoc(dir, ["docs/design"]),
      firstDoc(dir, ["docs/decisions", "docs/adr"]),
      readForge(dir, forge, autoLabel),
      readRuns(forge),
    ]);
    const report = buildGreenfieldReport({
      scan: scanEcosystem(dir),
      pinnedStackDoc: doc,
      docs: { prd, design, decisions },
      forge: forgeState,
      runs,
      now: this.#now(),
    });
    const prev = this.#cache.get(dir);
    this.#cache.set(dir, report);
    this.#resolveHold(dir, runs);
    this.#settle(dir, report, prev);
    return report;
  }

  /** Flip an active repo that reached the exit to `done`; tell the drain when its gate moved. */
  #settle(dir: string, report: GreenfieldReport, prev: GreenfieldReport | undefined): void {
    const b = this.deps.store.getRepoBootstrap(dir);
    if (bootstrapExitReached(b, report.mustHavesMissing)) {
      this.deps.store.setRepoBootstrap(dir, { state: "done", phase: BOOTSTRAP_LAST_PHASE });
      console.log(`[greenfield] bootstrap exit reached repo=${dir}`);
      this.deps.onChange?.(dir);
      return;
    }
    const changed = prev?.mustHavesMissing.join(",") !== report.mustHavesMissing.join(",");
    if (b.state === "active" && changed) this.deps.onChange?.(dir);
  }
}
