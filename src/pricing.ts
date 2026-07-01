// The TABLE values are real Anthropic $/Mtok list prices and MUST stay absolute — they must NOT
// be rescaled (e.g. normalized so a tier = 1), because /usage renders them as real currency via
// dollars() (and as USD-denominated "units" in the spend breakdown). A rescale would silently
// corrupt displayed money. The limit-% math (weightedUnits feeding the daily calibration) is
// ratio-only, so it is unaffected by keeping the absolute anchor. Keep the rows in price order
// so Fable stays the heaviest tier — its weight must exceed Opus's, matching the cost copy.

interface ModelWeights {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

const TABLE: { match: RegExp; w: ModelWeights }[] = [
  {
    // Opus 4.8 — $5/$25 per Mtok. (Was 15/75, the retired Claude 3 Opus price;
    // that stale value made the premium Fable tier look cheaper than Opus and
    // undercounted Opus consumption relative to Sonnet/Haiku.)
    match: /opus/i,
    w: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  },
  {
    match: /sonnet/i,
    w: { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  },
  {
    match: /haiku/i,
    w: { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
  },
  {
    // Fable 5 — list price $10 in / $50 out per Mtok (cache derived at the same
    // 0.1× / 1.25× / 2× ratios as the other tiers). Appended at the end (after
    // haiku) so the DEFAULT index (TABLE[1]) below stays sonnet-like.
    match: /fable/i,
    w: { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  },
];

const DEFAULT: ModelWeights = TABLE[1]!.w; // sonnet-like

const warned = new Set<string>();

function weightsFor(model: string): ModelWeights {
  for (const { match, w } of TABLE) if (match.test(model)) return w;
  // Sentinel ids like "<synthetic>" (synthetic/interrupt messages) carry no real pricing —
  // use the default weights silently instead of warning once per sentinel.
  if (/^<.+>$/.test(model)) return DEFAULT;
  if (!warned.has(model)) {
    warned.add(model);
    console.warn(`[usage] unknown model "${model}" — using default limit weights`);
  }
  return DEFAULT;
}

/** Cache-write portion of the weighted units (5m + 1h buckets, same scale as weightedUnits). */
export function cacheWriteUnits(
  c: { cacheWrite5m: number; cacheWrite1h: number },
  model: string,
): number {
  const w = weightsFor(model);
  return (c.cacheWrite5m * w.cacheWrite5m + c.cacheWrite1h * w.cacheWrite1h) / 1_000_000;
}

/** Weighted "limit units" for one usage record, in arbitrary (per-Mtok) units. */
export function weightedUnits(
  c: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
  },
  model: string,
): number {
  const w = weightsFor(model);
  return (
    (c.input * w.input +
      c.output * w.output +
      c.cacheRead * w.cacheRead +
      c.cacheWrite5m * w.cacheWrite5m +
      c.cacheWrite1h * w.cacheWrite1h) /
    1_000_000
  );
}

/** Absolute USD cost of a token bundle at list price — the money view of the same weighted
 *  units; displayed in /usage's api-key `$` column.
 *
 *  Intentional separation from `buildUsageBreakdown`: the spend breakdown — repo, total, AND
 *  per-task (#980) — sums per-record `weightedUnits` directly rather than calling `dollars()`
 *  on aggregate tokens. The accumulated `authoringUnits`/`satelliteUnits` ARE already list-price
 *  USD (`weightedUnits`, computed per-record from the full per-model + 5m/1h cache split), so
 *  re-pricing a task's flattened tokens with its single dominant model would diverge from the
 *  units shown in the same row and omit satellite units.
 *
 *  This function currently has no production caller and is retained as the documented canonical
 *  per-bundle money formula. `pricing-dollars.test.ts` pins `dollars(c) === weightedUnits(c)`
 *  so the two formulas cannot silently drift. */
export function dollars(
  c: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
  },
  model: string,
): number {
  const w = weightsFor(model);
  return (
    (c.input * w.input +
      c.output * w.output +
      c.cacheRead * w.cacheRead +
      c.cacheWrite5m * w.cacheWrite5m +
      c.cacheWrite1h * w.cacheWrite1h) /
    1_000_000
  );
}
