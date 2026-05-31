// Relative per-million-token weights used ONLY for the limit-% math — never displayed.
// Absolute scale is irrelevant: the daily /usage calibration backs out the cap against these,
// so only the ratios between models/kinds matter. Values track public API list prices.

export interface ModelWeights {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

const TABLE: { match: RegExp; w: ModelWeights }[] = [
  {
    match: /opus/i,
    w: { input: 15, output: 75, cacheRead: 1.5, cacheWrite5m: 18.75, cacheWrite1h: 30 },
  },
  {
    match: /sonnet/i,
    w: { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  },
  {
    match: /haiku/i,
    w: { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
  },
];

const DEFAULT: ModelWeights = TABLE[1]!.w; // sonnet-like

const warned = new Set<string>();

function weightsFor(model: string): ModelWeights {
  for (const { match, w } of TABLE) if (match.test(model)) return w;
  if (!warned.has(model)) {
    warned.add(model);
    console.warn(`[usage] unknown model "${model}" — using default limit weights`);
  }
  return DEFAULT;
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
