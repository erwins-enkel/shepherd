/** Order-preserving bounded-concurrency map: at most `limit` `fn`s run at once.
 *  Use instead of an unbounded `Promise.all` when each `fn` spawns a subprocess
 *  or hits a rate-limited API (e.g. one `gh api` call per item over a large list). */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
