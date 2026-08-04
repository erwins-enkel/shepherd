import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, afterEach } from "bun:test";
import { HerdrDriver } from "../src/herdr";
import { setDetectedHerdrVersion } from "../src/herdr-capabilities";
import { reapOrphanTabs } from "../src/tab-reaper";
import { reapTransientByLabel } from "../src/transient-tab-reaper";
import { MERGE_LABEL } from "../src/merge-suggest";

// ── The fixtures must keep telling the truth about herdr 0.7.5 (#2029) ────────
//
// The husk leak survived a full release cycle because `agent-list-registered.json` carried a
// `name` key the daemon never emits: every reaper test therefore ran against a record shape that
// does not exist, and CI stayed green while 321 husks accumulated on a real host. These
// assertions pin the two absences that matter. They are deliberately about the FIXTURE FILES, not
// about the parsers — a mapper can be fixed, but a fictional fixture silently un-tests the fix.
//
// Measured against a live herdr 0.7.5 (protocol 17) daemon:
//   tab list  — 508/508 tabs carried `label`
//   pane list — 35/508 panes carried `label`, and 0 of the 325 HELPER panes did
//   agent list — 0/8 agents carried `name`; a registered `--agent` value surfaces under `agent`

const FIX = join(import.meta.dir, "fixtures/herdr-responses/v0.7.5");
const fixture = (name: string): string => readFileSync(join(FIX, `${name}.json`), "utf8");
const parse = (name: string): Record<string, unknown> =>
  JSON.parse(fixture(name)).result as Record<string, unknown>;

test("the 0.7.5 agent-list fixture carries NO `name` key", () => {
  const agents = parse("agent-list-registered").agents as Record<string, unknown>[];
  expect(agents.length).toBeGreaterThan(0);
  for (const a of agents) {
    expect("name" in a).toBe(false);
    // The registered `--agent` label lands here instead — which is NOT a helper-label surface,
    // since a trusted auto-detected agent reports the bare kind ("claude").
    expect(typeof a.agent).toBe("string");
  }
});

test("the 0.7.5 pane-list fixture carries NO `label` on a husk pane", () => {
  const panes = parse("pane-list-husks").panes as Record<string, unknown>[];
  expect(panes.length).toBeGreaterThan(0);
  for (const p of panes) expect("label" in p).toBe(false);
});

test("every 0.7.5 tab-list fixture entry DOES carry a `label` — the surface the reapers key on", () => {
  for (const name of ["tab-list", "tab-list-helpers"]) {
    const tabs = parse(name).tabs as Record<string, unknown>[];
    expect(tabs.length).toBeGreaterThan(0);
    for (const t of tabs) expect(typeof t.label).toBe("string");
  }
});

// ── End-to-end: the real driver, driven entirely by captured 0.7.5 replies ────

const TAB_LIST_HELPERS = fixture("tab-list-helpers");
const PANE_LIST_HUSKS = fixture("pane-list-husks");
const AGENT_LIST = fixture("agent-list-registered");

/** `pane process-info`: the husk pane idles in a shell, the live agent pane runs claude. */
const PROCS: Record<string, string> = {
  "w1:p4": JSON.stringify({
    result: { process_info: { foreground_processes: [{ name: "bash" }] } },
  }),
  p_075: JSON.stringify({
    result: { process_info: { foreground_processes: [{ name: "claude" }] } },
  }),
};

function mkDriver(closed: string[]): HerdrDriver {
  const route = (args: string[]): string => {
    const [a, b] = args;
    if (a === "tab" && b === "list") return TAB_LIST_HELPERS;
    if (a === "pane" && b === "list") return PANE_LIST_HUSKS;
    if (a === "agent" && b === "list") return AGENT_LIST;
    if (a === "pane" && b === "process-info") return PROCS[args[3]!] ?? "{}";
    if (a === "tab" && b === "close") {
      closed.push(args[2]!);
      return JSON.stringify({ result: { type: "ok" } });
    }
    throw new Error(`unexpected herdr call: ${args.join(" ")}`);
  };
  return new HerdrDriver(route, async (args) => route(args));
}

afterEach(() => setDetectedHerdrVersion(null));

test("reapOrphanTabs reaps a 0.7.5 husk tab and spares the live helper (#2029)", async () => {
  setDetectedHerdrVersion("0.7.5");
  const closed: string[] = [];
  const d = mkDriver(closed);

  // Neither husk detection surface the old code used exists in these replies…
  expect(d.panes().every((p) => p.label === undefined)).toBe(true);
  expect(d.list().every((a) => a.name === undefined)).toBe(true);

  // …yet the sweep still finds both helper tabs and classifies them correctly.
  const r1 = await reapOrphanTabs(d);
  expect(r1.helperTabs).toBe(2);
  expect(r1.sparedLive).toBe(1); // the `review TASK-09` tab runs claude
  expect(r1.shellOnly).toEqual(new Set(["w1:t3"])); // the `__merge__` tab is a husk
  expect(closed).toEqual([]); // first sighting only — debounce

  const r2 = await reapOrphanTabs(d, r1.shellOnly);
  expect(r2.closed).toEqual(["w1:t3"]);
  expect(closed).toEqual(["w1:t3"]);
});

test("reapTransientByLabel closes a 0.7.5 husk tab by its label (#2029)", async () => {
  setDetectedHerdrVersion("0.7.5");
  const closed: string[] = [];
  await reapTransientByLabel(mkDriver(closed), MERGE_LABEL, new Set(), "[merge]");
  expect(closed).toEqual(["w1:t3"]);
});
