/** Guarded computed-property writes for the reactive record maps in the `*.svelte.ts` stores.
 *
 *  Lives in its own leaf module rather than in `store.svelte.ts` because `store.svelte.ts` already
 *  imports every sibling store (`reviews`, `recaps`, `epic-draft`, `buildQueues`); exporting the
 *  helpers from there and importing them back would make all four import cycles.
 *
 *  ── Why these exist ──────────────────────────────────────────────────────────────────────────
 *  A computed key in an object literal (`{ ...rec, [id]: v }`) is defined via
 *  CreateDataPropertyOrThrow, so it can NOT pollute a prototype: `__proto__` lands as an ordinary
 *  own property. These helpers are defence in depth: they keep a `__proto__` own key out of the
 *  maps *on the guarded write paths* — which matters because a later `[[Set]]`-based copy of such a
 *  map (e.g. `Object.assign(target, map)`) WOULD reach the setter. `safeMerge` covers the one place
 *  that already does an `Object.assign` of remote data.
 *
 *  This is NOT a whole-map invariant, and must not be relied on as one. The bulk seeds listed below
 *  assign or rebuild a decoded response wholesale (`ReviewsStore.load`'s `this.map = await
 *  getReviews()`, `HerdStore.setClaudeAlive`'s `Object.fromEntries(Object.entries(map))`), so an own
 *  `__proto__` from the server can still land in the very same maps by that route. Harmless today —
 *  it is an ordinary own property and no `[[Set]]` copy of these maps exists — but the guarantee
 *  here is per-write, not per-map.
 *
 *  Pick a helper by KEY SHAPE, never by convenience — see {@link setPathKey}.
 *
 *  ── Deliberately NOT routed through these (do not "tidy up") ─────────────────────────────────
 *  - `dropKey` and the inline `delete copy[id]` forms. A delete cannot create or redirect a
 *    prototype, so a guard adds nothing — but a REJECTED key would silently fail to delete,
 *    pinning a session as "Reviewing…" or leaving a stale verdict. Guarding there is a net loss.
 *  - Every `repoPath` write in `RepoConfigStore` (`reviews.svelte.ts`, exported as `repoConfig`) —
 *    deliberately uncounted here, since the figure drifts as config flags are added — and
 *    `HerdStore`'s `epics` composite key
 *    (`${repoPath}#${issue}`). Out of the remediated set; note they would need `setPathKey`, since
 *    {@link SAFE_ID} rejects both shapes.
 *  - `HerdStore`'s bulk-replace seeds (`setBuildQueues`, `setGit`, `setDrain`, …) that assign a
 *    server-provided object wholesale or rebuild via `Object.fromEntries` — neither is a computed
 *    write, and both are CreateDataProperty-safe. (Note this is the whole-map `setActivity(map)`,
 *    not `ReviewsStore.setActivity(id, …)`, which IS guarded — on the read as well as the write.)
 *
 *  So guarded and unguarded writes sit side by side, sometimes in the same function. That is
 *  intentional, not an oversight.
 */

/** Server-minted ids (`randomUUID()` — hex + hyphens) match. `__proto__` cannot: underscores are
 *  outside the class, which is what makes this a prototype-pollution barrier.
 *
 *  NOTE `constructor` and `prototype` DO match — they are pure letters. This regex is a
 *  prototype-pollution (WRITE) barrier only, and for that purpose admitting them is safe even on
 *  the one path that does a real `[[Set]]` write:
 *  - `Object.prototype.constructor` is a writable DATA property, not an accessor, so assigning it
 *    on a plain record creates an ordinary own property on the receiver — no setter runs.
 *  - `Object.prototype.prototype` does not exist at all, so that name is a plain own-property
 *    creation too.
 *  `__proto__` is the only name on `Object.prototype` backed by an accessor, which is exactly why
 *  excluding it is sufficient to stop pollution. ({@link setPathKey} and {@link safeMerge} still
 *  reject all three: their keys are arbitrary path/payload input, so shadowing a builtin is worth
 *  avoiding even when it cannot pollute.)
 *
 *  It does NOT make a subsequent READ of `map[id]` safe: `constructor`, `toString`, … pass this
 *  regex yet resolve up the prototype chain to a non-array. The one consumer that reads before
 *  writing (`ReviewsStore`/`PlanGateStore.setActivity` → `pushActivity`) hardens that read itself.
 *
 *  Exported so that every session-id guard in the stores tests against THIS regex rather than
 *  re-deriving the charset — that shared identity is the anti-drift property (#1630). Consumers are
 *  deliberately not enumerated here: the list has gone stale before, and `grep SAFE_ID` is both
 *  accurate and cheaper than a comment. */
export const SAFE_ID = /^[0-9a-zA-Z-]+$/;

/** Property names that reach `Object.prototype`'s setter (or shadow a builtin) on a `[[Set]]` write. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Immutably set `rec[id] = value`. `id` is a server-provided session id (a UUID/slug), so it is
 *  validated against a strict charset before the computed write — this both rejects malformed ids
 *  and forecloses any prototype-polluting property name (`__proto__` etc. never match) (#1630).
 *
 *  A rejected id is DROPPED (the record is returned unchanged). Safe for session-id-keyed maps
 *  because every real id is a `randomUUID()`; do NOT use it for path- or composite-keyed maps,
 *  whose legitimate keys the charset would reject — see {@link setPathKey}. */
export function setKey<T>(rec: Record<string, T>, id: string, value: T): Record<string, T> {
  if (!SAFE_ID.test(id)) return rec;
  return { ...rec, [id]: value };
}

/** {@link setKey} for maps whose keys are NOT session ids — repo paths (`drain`, `autoMerge`) and
 *  other shapes containing `/`, `.` or `#`, which the {@link SAFE_ID} charset would reject.
 *
 *  Rejecting only the three dangerous names is a complete barrier for prototype pollution. The
 *  charset variant is preferred where keys really are UUIDs because it additionally rejects
 *  malformed ids — but applying it to a path key would silently no-op the write and freeze that
 *  map in the UI with no error, so the two are not interchangeable.
 *
 *  Builds the result with `Object.fromEntries` — "every existing entry, plus this one" — rather
 *  than a `{ ...rec, [key]: v }` computed key. Identical semantics (both use CreateDataProperty,
 *  so neither can invoke a setter) and the same O(n) copy, but it expresses the key as data rather
 *  than as a dynamic property write.
 *
 *  That last point is deliberate. `js/remote-property-injection` models a regex allow-list as a
 *  sanitizing barrier — which is why {@link setKey} is not flagged — but does not model an equality
 *  chain, `Set.has()`, or `Object.defineProperty`. An allow-list cannot be used on this path:
 *  `repoPath` is arbitrary filesystem input, so any charset narrow enough to exclude `__proto__`
 *  could also reject a legitimate path and silently freeze the map, which is the exact failure this
 *  guard exists to prevent. The explicit check below remains the real barrier. */
export function setPathKey<T>(rec: Record<string, T>, key: string, value: T): Record<string, T> {
  if (key === "__proto__" || key === "constructor" || key === "prototype") return rec;
  return Object.fromEntries([...Object.entries(rec), [key, value]]) as Record<string, T>;
}

/** Strip prototype-polluting own keys from a payload before an `Object.assign`.
 *
 *  Needed because `Object.assign` uses `[[Set]]`: an own `__proto__` key — which `JSON.parse`
 *  *does* create, and object spread faithfully copies — would invoke the setter on the target
 *  rather than land as an ordinary property. The probe uses `Object.hasOwn`, so it catches such a
 *  key regardless of enumerability; the rebuild uses `Object.entries`, which keeps exactly the
 *  enumerable own keys a decoded WS payload carries.
 *
 *  Returns the input unchanged when there is nothing to strip. `patchSession` runs on every
 *  session push, so the clean path is kept allocation-free (three `hasOwn` probes, no key array). */
export function safeMerge<T extends object>(patch: T): T {
  let dirty = false;
  for (const k of UNSAFE_KEYS) if (Object.hasOwn(patch, k)) dirty = true;
  if (!dirty) return patch;
  return Object.fromEntries(Object.entries(patch).filter(([k]) => !UNSAFE_KEYS.has(k))) as T;
}
