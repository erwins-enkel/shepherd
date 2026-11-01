import { ApiError } from "#lib/api.js";
import { m } from "#lib/paraglide/messages.js";

/** What to toast when a plugin route refuses. A 4xx says why, in the plugin's own words (verbatim
 *  plugin DATA, as a success reply is). Anything else stays generic: a 5xx body is not written
 *  for an operator. */
export function routeFailureText(e: unknown): string {
  const refused = e instanceof ApiError && e.serverAuthored && e.status >= 400 && e.status < 500;
  return refused ? e.message : m.plugin_action_failed();
}
