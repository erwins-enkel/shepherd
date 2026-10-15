/**
 * Readiness greenfield profile (#3107) — I/O + cache. Gathers the inputs for
 * `greenfield-core.ts` (ecosystem scan, pinned-stack section, docs, forge settings, default-branch
 * runs), caches the report per repo and feeds the red must-haves to the bootstrap drain gate.
 *
 * Runs on its own while a repo is in `active` bootstrap: on entering it, on a cold or stale read
 * from the drain, and after every merged PR in the repo (fast-forwarding the local checkout first,
 * so the scan sees what landed). Reaching the exit predicate flips the repo to `done`.
 */
import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BOOTSTRAP_LAST_PHASE,
  READINESS_PENDING,
  type BootstrapSessionPhase,
  bootstrapExitReached,
  phaseAfterBootstrapMerge,
} from "./bootstrap";
import type { GitForge, ForgeRun } from "./forge/types";
import { buildGreenfieldReport, type GreenfieldReport } from "./greenfield-core";
import { fastForwardDefaultBranch, resolveDefaultBranch } from "./pull";
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
  store: Pick<SessionStore, "getRepoBootstrap" | "setRepoBootstrap" | "getRepoConfig">;
  resolveForge: (dir: string) => GitForge | null;
  /** The gate's inputs changed (must-haves, or the repo reached `done`) — kick the drain. */
  onChange?: (dir: string) => void;
  /** Fast-forward the local default-branch checkout; injectable for tests. */
  pull?: (dir: string, forge: GitForge | null) => Promise<void>;
  now?: () => number;
}

async function defaultPull(dir: string, forge: GitForge | null): Promise<void> {
  const branch = await resolveDefaultBranch(dir, {
    forgeDefault: forge ? () => forge.defaultBranch().catch(() => null) : undefined,
  });
  if (!branch) return;
  const r = await fastForwardDefaultBranch(dir, branch);
  if (!r.ok) console.warn(`[greenfield] fast-forward skipped repo=${dir} reason=${r.reason}`);
}

export class GreenfieldService {
  #cache = new Map<string, GreenfieldReport>();
  #inflight = new Map<string, Promise<GreenfieldReport>>();
  #lazyAt = new Map<string, number>();
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
    if (this.deps.store.getRepoBootstrap(dir).state !== "active")
      return hit?.mustHavesMissing ?? [];
    if (!hit || this.#now() - hit.checkedAt > STALE_MS) this.#lazyRefresh(dir);
    return hit ? [...hit.mustHavesMissing] : [READINESS_PENDING];
  }

  /** A PR merged in `dir`: in an active bootstrap, advance the phase when it was a bootstrap
   *  session's PR (#3110: P1+P2 → 3, P3 → 4), then pull what landed and re-scan. */
  async onMerged(dir: string, bootstrapPhase?: BootstrapSessionPhase | null): Promise<void> {
    const b = this.deps.store.getRepoBootstrap(dir);
    if (b.state !== "active") return;
    const next = bootstrapPhase ? phaseAfterBootstrapMerge(b, bootstrapPhase) : null;
    if (next != null) {
      this.deps.store.setRepoBootstrap(dir, { state: "active", phase: next });
      console.log(`[greenfield] bootstrap phase ${b.phase} → ${next} repo=${dir}`);
      this.deps.onChange?.(dir);
    }
    const forge = this.deps.resolveForge(dir);
    await (this.deps.pull ?? defaultPull)(dir, forge).catch((e: unknown) =>
      console.warn(`[greenfield] fast-forward failed repo=${dir}:`, e),
    );
    await this.refresh(dir);
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
