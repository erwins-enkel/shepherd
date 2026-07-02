import { installDemoBackend } from "$lib/demo/install";
import { director } from "$lib/demo/director";
import { startCommandBarShowcase } from "$lib/demo/showcase";

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
