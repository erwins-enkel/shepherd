// Runtime-keyed message lookup, scoped to key families (#3242).
//
// The build splits the Paraglide catalog per chunk by rewriting static `m.key()`
// calls (ui/vite/paraglide-split.ts) and fails on any other use of `m`. The one
// exception is this call shape, for lookups by a data-driven key:
//
//   const msg = keyedMessages(m, ["gloss_"]);
//   msg(term.bodyKey)?.();
//
// The build replaces `m` here with only the messages whose keys start with one
// of the (literal) prefixes, so just that family is bundled with the caller.
// Dev and tests pass the whole namespace; the prefix filter below keeps both
// behaving the same.

type Message = (inputs?: Record<string, unknown>) => string;

export function keyedMessages(
  messages: object,
  prefixes: readonly string[],
): (key: string) => Message | undefined {
  const byKey = new Map<string, Message>();
  for (const [key, fn] of Object.entries(messages))
    if (typeof fn === "function" && prefixes.some((p) => key.startsWith(p)))
      byKey.set(key, fn as Message);
  return (key) => byKey.get(key);
}
