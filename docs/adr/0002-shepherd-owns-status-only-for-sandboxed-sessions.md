---
status: accepted
---

# Shepherd pushes herdr agent state only for genuinely sandboxed sessions; herdr owns trusted ones

herdr (the terminal multiplexer that hosts every agent pane) normally detects an agent by its pane's foreground process and owns that agent's status (`idle` / `working` / `blocked`). From herdr 0.7.5 on, Shepherd spawns through herdr's external-registration path (`tab create` → `pane run` → `pane report-agent`, #1889/#1890). A sandboxed session runs its agent inside the `bwrap` membrane, so the pane's foreground is `bwrap`, not the agent binary, and herdr can never detect it: Shepherd registers it explicitly and from then on pushes the state it derives itself from the terminal and hook signals (#1891). A trusted session's foreground _is_ the agent binary, which herdr detects on its own. Registering it or pushing a `--state` would suppress that detection and pin the status at `working`, because herdr does not accept a client's step back down to `idle`. So ownership is split by sandboxing: Shepherd owns the state of sandboxed sessions, herdr owns trusted ones, and Shepherd never pushes for a session it does not own.

## Consequences

- "Sandboxed" means a non-`trusted` sandbox profile was actually applied **and** the session was not degraded to unconfined. A degraded session runs without `bwrap`, so herdr sees it and it counts as trusted. The predicate is `isSandboxedSession` in `src/poller.ts`; the spawn side branches on whether the argv contains `bwrap` (`src/herdr.ts`). Anything new that reports or registers agent state must use the same split.
- Below herdr 0.7.5 (legacy `agent start`) nothing is registered and herdr owns every session's status. Shepherd pushes only when `herdrUsesExternalRegistrationSpawn()` is true.
- For sandboxed sessions Shepherd is the sole source of truth: if its classifier is wrong, herdr shows the wrong state. A failed push is rolled back and retried on the next poll tick rather than left as a value herdr never received.
