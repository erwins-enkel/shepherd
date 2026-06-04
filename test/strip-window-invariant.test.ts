import { test, expect } from "bun:test";
import { DEFAULT_STALL } from "../src/stall";
import { STRIP_WINDOW_MS } from "../ui/src/lib/heartbeat";

// The UI cannot import server code at runtime, so `STRIP_WINDOW_MS` is a literal
// mirror of the server's stall threshold. This guard fails loudly if the two ever
// diverge — otherwise the "fully-drained strip == stalled" invariant would break
// silently when the stall threshold is tuned.
test("UI heat-strip window matches the server stall threshold", () => {
  expect(STRIP_WINDOW_MS).toBe(DEFAULT_STALL.stallMs);
});
