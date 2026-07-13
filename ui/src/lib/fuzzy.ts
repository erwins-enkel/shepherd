export type FuzzyKind = "empty" | "exact" | "prefix" | "substring" | "fuzzy";

/** Result of a successful fuzzy match: a relevance `score` (higher is better), its
 *  confidence `kind`, and the indices in the ORIGINAL `text` that the query matched —
 *  the latter drive match highlighting, so they must line up with the un-lowercased string. */
export interface FuzzyResult {
  score: number;
  positions: number[];
  kind: FuzzyKind;
  span: number;
}

const BASE = 1; // every consumed query char
const BOUNDARY_BONUS = 10; // match at index 0 or right after a separator (prefixes win)
const CONSEC_BONUS = 5; // match adjacent to the previous one (contiguous runs win)
const SEPARATOR = /[\s\-_/.]/;
const TIER_BASE: Record<Exclude<FuzzyKind, "empty">, number> = {
  exact: 4000,
  prefix: 3000,
  substring: 2000,
  fuzzy: 1000,
};
const QUALITY_LIMIT = 250;

/**
 * Case-insensitive fuzzy subsequence match with relevance scoring.
 *
 * Returns `null` when `query` is not a subsequence of `text` (all query chars must appear in
 * order), or when a non-contiguous match spans too much unrelated text to be useful. An empty
 * query matches everything with score 0 and no positions — callers rely on this to preserve
 * their default (unfiltered) ordering.
 *
 * Matching is greedy left-to-right: each query char binds to the earliest remaining occurrence.
 * This is not an optimal alignment (a DP would find the highest-scoring one), but it is simple,
 * allocation-light, and more than adequate for the short strings a command bar searches.
 */
export function fuzzyScore(query: string, text: string): FuzzyResult | null {
  if (query.length === 0) return { score: 0, positions: [], kind: "empty", span: 0 };
  const q = query.toLowerCase();
  // Compare case-insensitively per character against the ORIGINAL text — not a pre-lowercased
  // copy — so `positions` index the original string. Lowercasing the whole haystack can shift
  // indices when a char's lowercase form has a different length (e.g. "İ" → "i̇"), which would
  // misplace the highlight.
  const positions: number[] = [];
  let quality = 0;
  let qi = 0;
  let prev = -2; // guarantees the first match is never counted as "consecutive"
  for (let ti = 0; ti < text.length && qi < q.length; ti++) {
    if (text[ti].toLowerCase() === q[qi]) {
      let bonus = BASE;
      if (ti === 0 || SEPARATOR.test(text[ti - 1])) bonus += BOUNDARY_BONUS;
      if (ti === prev + 1) bonus += CONSEC_BONUS;
      quality += bonus;
      positions.push(ti);
      prev = ti;
      qi++;
    }
  }
  if (qi !== q.length) return null;

  const span = positions.at(-1)! - positions[0] + 1;
  const consecutive = span === q.length;
  let kind: Exclude<FuzzyKind, "empty">;
  if (consecutive && positions[0] === 0 && span === text.length) kind = "exact";
  else if (consecutive && positions[0] === 0) kind = "prefix";
  else if (consecutive) kind = "substring";
  else kind = "fuzzy";

  if (kind === "fuzzy" && span > Math.max(q.length * 3, q.length + 2)) return null;

  quality -= span - q.length;
  quality = Math.max(-QUALITY_LIMIT, Math.min(QUALITY_LIMIT, quality));
  return { score: TIER_BASE[kind] + quality, positions, kind, span };
}
