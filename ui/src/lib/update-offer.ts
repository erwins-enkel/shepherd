/**
 * Offers a reload once a newer UI build is deployed. SvelteKit's `updated` compares the bundle's
 * version with `/_app/version.json` (checked on focus, hourly, and by us on WS reconnect); a deploy
 * rewrites every hashed chunk, so code-split panels fail to load until the page reloads. Offer only:
 * an automatic reload could drop an unsent draft or terminal input.
 */
import { updated } from "$app/state";
import { toasts } from "#lib/toasts.svelte.js";
import { m } from "#lib/paraglide/messages.js";

/** True once SvelteKit has seen a newer deployed build. */
export function appUpdated(): boolean {
  return updated.current;
}

/** Force a version check now (e.g. the server just restarted). Never throws. */
export function checkForUpdate(): void {
  updated.check().catch(() => {});
}

/** One sticky toast, deduped by key, whose action reloads into the new build. */
export function offerUpdateReload(): void {
  toasts.info(m.app_updated(), {
    sticky: true,
    key: "app-updated",
    action: { label: m.viewport_browser_reload(), run: () => location.reload() },
  });
}
