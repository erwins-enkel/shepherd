import type { PrStatus } from "./forge/types";

/** How long one landing-PR read is shared (#2756). */
export const LANDING_PR_TTL_MS = 60_000;

/**
 * One `prStatus` per repo+branch per {@link LANDING_PR_TTL_MS}, shared by every caller: GET
 * /api/epics/completed and the drain's landing-gate fallback for rows no tick read or snapshot
 * covers (#2858). The cached promise is the single-flight; a failure is evicted.
 */
export class LandingPrStatusCache {
  private readonly cache = new Map<string, { at: number; value: Promise<PrStatus> }>();

  constructor(private readonly now: () => number = Date.now) {}

  read(
    forge: { prStatus: (branch: string) => Promise<PrStatus> },
    repoPath: string,
    branch: string,
  ): Promise<PrStatus> {
    const key = `${repoPath}\0${branch}`;
    const now = this.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < LANDING_PR_TTL_MS) return hit.value;
    const value = forge.prStatus(branch);
    this.cache.set(key, { at: now, value });
    value.catch(() => {
      if (this.cache.get(key)?.value === value) this.cache.delete(key);
    });
    return value;
  }
}

/** The process-wide instance the GET and the drain share. */
export const landingPrCache = new LandingPrStatusCache();
