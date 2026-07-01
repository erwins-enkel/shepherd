import { installDemoBackend } from "$lib/demo/install";

// Demo build seam. `__DEMO__` is a Vite `define` — `false` for normal builds
// (the whole branch + import dead-code-eliminates) and `true` only for
// `bun run build:demo`. This must be the earliest client code so the fake fetch/WS
// are installed before any api call or store connect runs.
if (__DEMO__) {
  installDemoBackend();
}
