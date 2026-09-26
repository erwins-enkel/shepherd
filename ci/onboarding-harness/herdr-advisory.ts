import { HERDR_LAST_SUPPORTED_VERSION, parseHerdrVersion } from "../../src/herdr-capabilities";
import { HERDR_LATEST_URL } from "../../src/herdr-install";
import { compareSemver } from "../../src/semver";

/** herdr's latest published release vs Shepherd's supported ceiling (#1905). `ahead` is an
 *  UPSTREAM event, not a Shepherd regression — surfaced in the report, status line and its own
 *  advisory issue, never gated. */
export interface HerdrCeilingCheck {
  latest: string;
  ceiling: string;
  ahead: boolean;
}

const FETCH_TIMEOUT_MS = 10_000;

const defaultFetchLatest = async (): Promise<unknown> => {
  const res = await fetch(HERDR_LATEST_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

/** Compare herdr's latest published release against the ceiling. Never throws: a fetch
 *  failure or malformed payload yields null ("unknown" — the harness must not go red, or
 *  close the advisory issue, because herdr.dev was briefly unreachable). */
export async function checkHerdrCeiling(
  fetchLatest: () => Promise<unknown> = defaultFetchLatest,
  ceiling: string = HERDR_LAST_SUPPORTED_VERSION,
): Promise<HerdrCeilingCheck | null> {
  try {
    const raw = (await fetchLatest()) as { version?: unknown } | null;
    const latest = typeof raw?.version === "string" ? parseHerdrVersion(raw.version) : null;
    if (!latest) throw new Error("no parseable version in latest.json");
    return { latest, ceiling, ahead: compareSemver(latest, ceiling) > 0 };
  } catch (err) {
    console.warn(
      `[herdr-advisory] latest.json check skipped: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

/** Markdown line for the gap report / advisory issue body. */
export function advisoryLine(c: HerdrCeilingCheck): string {
  return `- herdr **${c.latest}** is out, above Shepherd's supported ceiling **${c.ceiling}** — an upstream release, not a regression; raise the ceiling (herdr-compat skill).`;
}
