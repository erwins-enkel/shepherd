// Registry of coach-target DOM nodes, keyed by feature id.
// Uses SvelteMap so reactive reads (e.g. inside $effect) track changes.
// The action registers a node on mount and deregisters it on destroy, so
// Floating UI never anchors against a detached element after a session switch.

import { SvelteMap } from "svelte/reactivity";

export const coachTargets = new SvelteMap<string, HTMLElement>();

/**
 * Svelte action — use:coachTarget={"critic"} on any button/element that
 * a <Coachmark> should anchor to.
 */
export function coachTarget(node: HTMLElement, id: string) {
  coachTargets.set(id, node);

  return {
    update(newId: string) {
      if (newId !== id) {
        coachTargets.delete(id);
        id = newId;
        coachTargets.set(id, node);
      }
    },
    destroy() {
      coachTargets.delete(id);
    },
  };
}
