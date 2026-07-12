import { test, expect } from "bun:test";
import { HerdrUsageProbe, PROBE_NAME, awaitUsageFrame } from "../src/usage-probe";
import { parseUsageFrame } from "../src/usage-limits";
import type { HerdrAgent } from "../src/herdr";
import { config } from "../src/config";

function agent(over: Partial<HerdrAgent>): HerdrAgent {
  return {
    agent: "claude",
    agentStatus: "idle",
    cwd: "/repo",
    name: "",
    paneId: "p",
    tabId: "t",
    terminalId: "term",
    workspaceId: "w",
    ...over,
  };
}

// Regression: probes used to leak a herdr tab whenever start() threw *after* `tab create`
// succeeded — the catch returned before the terminalId-based cleanup could run, so the tab was
// orphaned forever and piled up daily. scrape() now reaps every probe agent (by the reserved
// PROBE_NAME) up front (and on every exit), self-healing past leaks regardless of how the prior
// run died — while leaving every real session strictly alone, INCLUDING one a user happened to
// name "usage-probe" (a producible prompt slug that the old bare-string match would have killed).
test("scrape returns null without calling herdr.start in api-key mode", async () => {
  const prior = config.authMode;
  try {
    config.authMode = "api-key";
    let startCalled = false;
    const herdr = {
      list: () => [] as HerdrAgent[],
      start: async () => {
        startCalled = true;
        throw new Error("herdr.start must not be called in api-key mode");
      },
      stop: async () => {},
    };
    const result = await new HerdrUsageProbe(herdr, "/repo").scrape();
    expect(result).toBeNull();
    expect(startCalled).toBe(false);
  } finally {
    config.authMode = prior;
  }
});

test("scrape reaps leftover probe tabs and never touches real sessions", async () => {
  const stopped: string[] = [];
  const agents = [
    agent({ name: PROBE_NAME, terminalId: "old1", paneId: "po1" }),
    agent({ name: PROBE_NAME, terminalId: "old2", paneId: "po2" }),
    agent({ name: "flatten", terminalId: "keep", paneId: "pk" }), // real session
    // a user session whose prompt slugged to the OLD probe string — must survive the reserved-name
    // match (the collision this guards against).
    agent({ name: "usage-probe", terminalId: "user", paneId: "pu" }),
  ];
  const herdr = {
    list: () => agents,
    start: async () => {
      throw new Error("agent start failed after tab create");
    },
    stop: async (id: string) => {
      stopped.push(id);
    },
  };

  // Inject trust deps so the pre-seed never touches the developer's real ~/.claude.json.
  const res = await new HerdrUsageProbe(herdr, "/repo", undefined, {
    readTrusted: async () => true,
  }).scrape();

  expect(res).toBeNull();
  // both leftover probes reaped…
  expect(stopped).toContain("old1");
  expect(stopped).toContain("old2");
  // …real sessions are left alone — the plain one and the "usage-probe"-slugged user session.
  expect(stopped).not.toContain("keep");
  expect(stopped).not.toContain("user");
});

// ── trust pre-seed (#1075) ───────────────────────────────────────────────────
// An untrusted cwd makes claude boot into the folder-trust dialog, eating the probe's
// /usage keystrokes → null scrape. scrape() now pre-seeds trust (read-gated) before
// spawning. herdr.start is made to throw so each case returns null right after the
// pre-seed, letting us assert whether trust() ran — without a real PTY.

function throwingHerdr() {
  return {
    list: () => [] as HerdrAgent[],
    start: async () => {
      throw new Error("start stubbed — return null after pre-seed");
    },
    stop: async () => {},
  };
}

test("scrape seeds trust once when the cwd is untrusted", async () => {
  let trustCalls = 0;
  const res = await new HerdrUsageProbe(throwingHerdr(), "/repo", undefined, {
    readTrusted: async () => false,
    trust: async () => {
      trustCalls++;
    },
  }).scrape();

  expect(res).toBeNull();
  expect(trustCalls).toBe(1); // pre-seed ran before start
});

test("scrape does not write when the cwd is already trusted", async () => {
  let trustCalls = 0;
  await new HerdrUsageProbe(throwingHerdr(), "/repo", undefined, {
    readTrusted: async () => true,
    trust: async () => {
      trustCalls++;
    },
  }).scrape();

  expect(trustCalls).toBe(0); // read-gated: no write when already trusted
});

test("scrape never touches trust in api-key mode", async () => {
  const prior = config.authMode;
  try {
    config.authMode = "api-key";
    let touched = false;
    const res = await new HerdrUsageProbe(throwingHerdr(), "/repo", undefined, {
      readTrusted: async () => {
        touched = true;
        return false;
      },
      trust: async () => {
        touched = true;
      },
    }).scrape();
    expect(res).toBeNull();
    expect(touched).toBe(false); // api-key short-circuit fires before the pre-seed
  } finally {
    config.authMode = prior;
  }
});

test("scrape returns null (never throws) when the trust read throws", async () => {
  const res = await new HerdrUsageProbe(throwingHerdr(), "/repo", undefined, {
    readTrusted: async () => {
      throw new Error("EACCES");
    },
  }).scrape();
  expect(res).toBeNull(); // best-effort: a trust failure must not reject scrape()
});

test("scrape returns null (never throws) when the trust write throws", async () => {
  const res = await new HerdrUsageProbe(throwingHerdr(), "/repo", undefined, {
    readTrusted: async () => false,
    trust: async () => {
      throw new Error("ENOSPC");
    },
  }).scrape();
  expect(res).toBeNull();
});

// ── awaitUsageFrame: the credits-grace gate ──────────────────────────────────
// Regression for the "extra-credit gauge stuck stale, refresh never clears it" bug. The wait used
// to gate ONLY on the weekly window and return the instant week's "Resets …" line appeared — but
// the "Usage credits" panel renders BELOW week and streams in a cycle later, so it was missed and
// its snapshot never advanced. awaitUsageFrame now waits a bounded grace for credits after week.
// The fake `read` evolves with the fake `sleep`'s step counter so the grace loop is genuinely
// exercised (a static both-present buffer would pass without ever looping).

const WEEK_ONLY = "Current week (all models)\n 50% used\nResets Jun 7 (Europe/Berlin)\n";
const WEEK_PLUS_CREDITS =
  WEEK_ONLY + "Esc to cancel\nUsage credits\n 64% used\n€79.16/€100.00 spent · Resets Jul 1 (x)\n";

const hasCredits = (buf: string | null) => !!(buf && parseUsageFrame(buf, 0).credits);

test("awaitUsageFrame waits the grace for credits that render a few cycles after week", async () => {
  let step = 0;
  const sleep = async () => {
    step++;
  };
  // week+label is present immediately; credits only appears from the 3rd grace cycle on
  const read = () => (step < 3 ? WEEK_ONLY : WEEK_PLUS_CREDITS);

  const out = await awaitUsageFrame(read, sleep, 12, 6);

  expect(hasCredits(out)).toBe(true); // captured credits — would have been null without the grace
  expect(step).toBe(3); // grace actually looped until credits landed
});

test("awaitUsageFrame returns immediately when credits already rendered (no added latency)", async () => {
  let sleeps = 0;
  const sleep = async () => {
    sleeps++;
  };
  const out = await awaitUsageFrame(() => WEEK_PLUS_CREDITS, sleep, 12, 6);

  expect(hasCredits(out)).toBe(true);
  expect(sleeps).toBe(0); // week + credits both present on the first read → no waiting at all
});

test("awaitUsageFrame falls through after a bounded grace on a true no-credit account", async () => {
  let sleeps = 0;
  const sleep = async () => {
    sleeps++;
  };
  const out = await awaitUsageFrame(() => WEEK_ONLY, sleep, 12, 6);

  expect(out).toBe(WEEK_ONLY); // week captured…
  expect(hasCredits(out)).toBe(false); // …no credits fabricated
  expect(sleeps).toBe(6); // grace is bounded (creditTries) — never hangs
});

test("awaitUsageFrame returns null and skips the grace when the week never renders", async () => {
  let sleeps = 0;
  const sleep = async () => {
    sleeps++;
  };
  const out = await awaitUsageFrame(() => "", sleep, 12, 6);

  expect(out).toBeNull(); // scrape failed — week absent
  expect(sleeps).toBe(12); // waited out the week budget…
  // …but no credits grace ran (week falsy) — 12, not 12+6
});
