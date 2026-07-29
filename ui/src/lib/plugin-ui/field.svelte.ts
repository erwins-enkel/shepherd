// Shared field plumbing for every plugin-ui input node (issue #1961). All four input
// components (text-input / select / checkbox / number) need the exact same lifecycle —
// register under `name`, re-seed from the published `value`, drop the key on destroy — so it
// lives here once rather than four times.
//
// The subtle part is RE-SEEDING. A plugin may re-publish its panel at any time (a live panel
// often does so on a timer), and each publish re-renders the same component instances with new
// props. Blindly syncing local state from props on every render would erase whatever the
// operator is mid-way through typing. So the seed is applied only when the PUBLISHED value
// actually changes: a timer re-publish carrying the same value is a no-op, while a re-publish
// after a save does snap the field to the persisted truth.

import { getContext, onDestroy } from "svelte";
import { PLUGIN_FORM_CONTEXT, type PluginFormScope } from "./context";

export interface PluginField<T> {
  /** What the control displays right now. */
  readonly value: T;
  /** Record an operator edit: updates the display AND the submitted value. */
  set(next: T): void;
}

/** Wire one input node into its view's form scope.
 *
 *  @param name  Thunk reading the node's `name` prop. A field with an empty name registers
 *               nothing (the server validator requires one, so this only guards a bare mount).
 *  @param seed  Thunk reading the node's published `value`, already coerced to the display
 *               type `T`. Must be a primitive — re-seeding compares it with `!==`.
 *  @param toScope  Maps the displayed value to the value actually submitted. Defaults to
 *               identity. `number` uses it to hold raw text while posting a parsed number, so
 *               a half-typed "1." is never round-tripped through a numeric coercion.
 */
export function pluginField<T>(
  name: () => string,
  seed: () => T,
  toScope: (value: T) => unknown = (value) => value,
): PluginField<T> {
  // Context-absent (a bare PluginUIRenderer mount with no PluginUIRoot): the control still
  // renders and edits locally, it just contributes no field — mirroring how PuiActionButton
  // stays inert without a plugin id.
  const scope = getContext<PluginFormScope | undefined>(PLUGIN_FORM_CONTEXT);

  let lastName = name();
  let lastSeed = seed();
  let current = $state<T>(lastSeed);

  const register = (key: string, value: T): void => {
    if (key.length > 0) scope?.set(key, toScope(value));
  };
  const unregister = (key: string): void => {
    if (key.length > 0) scope?.remove(key);
  };

  register(lastName, lastSeed);

  $effect(() => {
    const nextName = name();
    const nextSeed = seed();
    // A renamed field at the same tree position: retire the old key so it cannot keep
    // contributing to submits, then adopt the new one.
    if (nextName !== lastName) {
      unregister(lastName);
      lastName = nextName;
      lastSeed = nextSeed;
      current = nextSeed;
      register(nextName, nextSeed);
      return;
    }
    // Same field, genuinely new published value → re-seed. Unchanged → leave the edit alone.
    if (nextSeed !== lastSeed) {
      lastSeed = nextSeed;
      current = nextSeed;
      register(nextName, nextSeed);
    }
  });

  onDestroy(() => unregister(lastName));

  return {
    get value() {
      return current;
    },
    set(next: T) {
      current = next;
      register(lastName, next);
    },
  };
}
