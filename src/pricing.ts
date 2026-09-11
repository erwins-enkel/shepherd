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
    // Opus — $5/$25 per Mtok. Unchanged across the current Opus generation
    // (Opus 5 lists at the same $5/$25 as 4.8), and the /opus/i match already
    // covers both the floating alias and the pinned `claude-opus-5` model id.
    // (Was 15/75, the retired Claude 3 Opus price; that stale value made the
    // premium Fable tier look cheaper than Opus and undercounted Opus
    // consumption relative to Sonnet/Haiku.)
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
    // Fable 5 — the RETIRED-price row, matched by the `-5` suffix ANCHORED so it
    // cannot swallow `claude-fable-5-1`. Covers the pinned id `claude-fable-5`
    // (plus its bedrock/mantle-prefixed forms, which also end in `-5`) at its own
    // list price: $10/$50 with cache read at the usual 0.1× ratio. Records from
    // Fable 5 sessions must keep costing what they cost, so this row exists
    // separately from the row below instead of being repriced with it.
    match: /fable-5$/i,
    w: { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  },
  {
    // Fable, CURRENT generation — $10 in / $50 out per Mtok with cache read at
    // $0.25 (Fable 5.1 cheapened cache reads from the 0.1× ratio Fable 5 used;
    // cache WRITES kept the 1.25× / 2× ratios). Covers the pinned id
    // `claude-fable-5-1` and the floating alias `fable`, which resolves to
    // whatever the installed CLI calls the latest Fable — 5.1 today. An
    // unrecognised future id (`claude-fable-6`) lands here rather than on the
    // retired prices above; give it its own row when its price is known.
    // Both fable rows sit after haiku so the DEFAULT index (TABLE[1]) below
    // stays sonnet-like.
    match: /fable/i,
    w: { input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 },
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

// ── Cold-resume estimate (#2042) ─────────────────────────────────────────────

/** The cache TTL that applies to a session's MAIN conversation. Claude Code requests the one-hour
 *  TTL only on a Claude subscription within the plan's included usage; an api key (or a cloud
 *  provider) gets five minutes. Subagents are always on 5m and are irrelevant here — a resume
 *  re-sends the main conversation. */
export type CacheTtl = "5m" | "1h";

/**
 * Tokens of a resumed session's prefix that stay cached even after its conversation has gone cold.
 *
 * A cold resume is NOT a full rebuild. Claude Code layers each request `system prompt → project
 * context → conversation`, and Shepherd runs many sessions against the same system prompt, so that
 * leading layer is continuously re-warmed by the rest of the herd while an individual session's
 * conversation body expires alone.
 *
 * Measured over 168 real cold resumes (>1h idle, >50% of context rebuilt) in a 211-transcript
 * corpus, the surviving prefix was p10 20.8k / p50 23.5k / p90 28.5k tokens — stable even across a
 * 675-hour gap. 24k is that median. Pricing the WHOLE context at the write rate instead would
 * overstate a 175k-context resume by ~14%.
 */
export const WARM_PREFIX_TOKENS = 24_000;

/**
 * Weighted units the NEXT turn into a cold session will cost: the surviving prefix is re-read at
 * the cache-read rate and everything beyond it is re-written at `ttl`'s cache-write rate.
 *
 * Validated against the same 168 resumes: predicted/actual p50 0.99x, 97% within ±33%.
 *
 * Built on the public `weightedUnits` rather than the private `weightsFor`, the same way
 * `accumulateCostRecord` isolates cacheRead-only units.
 */
export function coldResumeUnits(contextTokens: number, model: string, ttl: CacheTtl): number {
  if (contextTokens <= 0) return 0;
  const warm = Math.min(contextTokens, WARM_PREFIX_TOKENS);
  const rebuilt = contextTokens - warm;
  return weightedUnits(
    {
      input: 0,
      output: 0,
      cacheRead: warm,
      cacheWrite5m: ttl === "5m" ? rebuilt : 0,
      cacheWrite1h: ttl === "1h" ? rebuilt : 0,
    },
    model,
  );
}
