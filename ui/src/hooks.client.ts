import type { HandleClientError } from "@sveltejs/kit";
import { installDemoBackend } from "$lib/demo/install";
import { director } from "$lib/demo/director";
import { startCommandBarShowcase } from "$lib/demo/showcase";
import { classifyClientError, errorText } from "$lib/client-error";

/**
 * Without this hook SvelteKit renders its own unstyled fallback for any non-`HttpError` thrown on
 * the client — a bare `500` / `Internal Error` with no app chrome, no explanation and no way back.
 * The usual cause is a route chunk that never arrived (flaky link, or a deploy that rewrote every
 * hashed chunk), which is retryable rather than fatal. Classify it here so `+error.svelte` can say
 * something true about it. Keep the console trace: `kind` is a hint for the reader, not a
 * diagnosis, and swallowing the original error would make a real app fault invisible.
 */
export const handleError: HandleClientError = ({ error }) => {
  const kind = classifyClientError(error);
  console.error("[shepherd] unhandled client error", { kind, error });
  return { message: errorText(error), kind };
};

// Demo build seam. `__DEMO__` is a Vite `define` — `false` for normal builds
// (the whole branch + import dead-code-eliminates) and `true` only for
// `bun run build:demo`. This must be the earliest client code so the fake fetch/WS
// are installed before any api call or store connect runs.
if (__DEMO__) {
  installDemoBackend();
  // Ambient liveness + mutation reactions. Kept OUT of installDemoBackend() so unit
  // tests can install the fake backend without spinning up the director's timers.
  director.start();
  startCommandBarShowcase();
}
