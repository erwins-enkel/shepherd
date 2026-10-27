import { fuzzyScore, type FuzzyKind } from "./fuzzy";

/** What a repo picker searches and ranks on: the visible `name`, secondary `aliases`
 *  (slug, display path) that also match but rank below a name hit, and usage signals. */
export interface RepoSearchKey {
  name: string;
  aliases: string[];
  recentAgentCount?: number | null;
  lastUsedAt?: number;
}

const TIER: Record<Exclude<FuzzyKind, "empty">, number> = {
  exact: 3,
  prefix: 2,
  substring: 1,
  fuzzy: 0,
};

/** Match kind for one field. A literal hit is checked first: fuzzyScore's greedy
 *  earliest-occurrence alignment can miss a substring further along ("api" in
 *  "acme-payments-api") or downgrade it to fuzzy, so it is only the fallback. */
function matchKind(query: string, text: string): Exclude<FuzzyKind, "empty"> | null {
  const lower = text.toLowerCase();
  const at = lower.indexOf(query);
  if (at === 0) return lower.length === query.length ? "exact" : "prefix";
  if (at > 0) return "substring";
  const res = fuzzyScore(query, text);
  return res === null || res.kind === "empty" ? null : res.kind;
}

/** Best match across name + aliases as a single comparable number: the match tier,
 *  with a name hit beating an alias hit of the same tier. `null` when nothing matches. */
function matchRank(query: string, key: RepoSearchKey): number | null {
  let best: number | null = null;
  const q = query.toLowerCase();
  for (const [i, text] of [key.name, ...key.aliases].entries()) {
    const kind = matchKind(q, text);
    if (kind === null) continue;
    const rank = TIER[kind] * 2 + (i === 0 ? 1 : 0);
    if (best === null || rank > best) best = rank;
  }
  return best;
}

/**
 * Filter + rank repos for a picker search. A blank query returns the input order
 * untouched (callers keep their default grouping). Otherwise non-matches drop out and
 * the rest sort by match tier (exact > prefix > substring > fuzzy; name over alias),
 * then recent agent count, then last used, then name — so usage only reorders repos
 * that match equally well.
 */
export function searchRepos<T>(
  query: string,
  items: readonly T[],
  key: (item: T) => RepoSearchKey,
): T[] {
  const q = query.trim();
  if (q === "") return [...items];
  return items
    .map((item) => {
      const k = key(item);
      return { item, k, rank: matchRank(q, k) };
    })
    .filter((e): e is { item: T; k: RepoSearchKey; rank: number } => e.rank !== null)
    .sort(
      (a, b) =>
        b.rank - a.rank ||
        (b.k.recentAgentCount ?? 0) - (a.k.recentAgentCount ?? 0) ||
        (b.k.lastUsedAt ?? 0) - (a.k.lastUsedAt ?? 0) ||
        a.k.name.localeCompare(b.k.name),
    )
    .map((e) => e.item);
}
