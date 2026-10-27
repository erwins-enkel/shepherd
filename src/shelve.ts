import type { Session } from "./types";

/** The one predicate automation uses to leave a shelved session alone (sibling of
 *  `isOperatorAssistant`). Null-safe so call sites can pass a `store.get` result straight in. */
export function isShelved(s: Pick<Session, "shelved"> | null | undefined): boolean {
  return s?.shelved === true;
}
