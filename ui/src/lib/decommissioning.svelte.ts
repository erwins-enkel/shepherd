// Sessions whose decommission commit has started: the undo window is over, so the toast (and with
// it `toasts.pendingUndo`) is gone, but the row stays listed until the server's session:archived
// drops it. Rows in here stay dimmed meanwhile so they never flash back as active.
//
// Marked when the commit starts; cleared when it fails, and by the store on session:archived /
// session:new — a restored session comes back under the same id and must not stay dimmed.
import { SvelteSet } from "svelte/reactivity";

const committing = new SvelteSet<string>();

export function markDecommissioning(id: string): void {
  committing.add(id);
}

export function clearDecommissioning(id: string): void {
  committing.delete(id);
}

export function isDecommissioning(id: string): boolean {
  return committing.has(id);
}
