import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../../app.css";
import { m } from "#lib/paraglide/messages.js";
import type { GitState, Session, SteerLogEntry, WorkflowJob } from "#lib/types.js";

const api = vi.hoisted(() => ({
  restartCiJob: vi.fn(async () => {}),
  setSessionAutopilot: vi.fn(async () => {}),
  interruptSession: vi.fn(async () => {}),
}));
vi.mock("#lib/api.js", async (orig) => ({ ...(await orig<object>()), ...api }));

import PulseActionBanner from "./PulseActionBanner.svelte";

const MIN = 60_000;
const JOB_URL = "https://github.com/o/r/actions/runs/42/job/7";
const session = (over: Partial<Session> = {}) =>
  ({ id: "s1", status: "running", createdAt: Date.now() - 90 * MIN, ...over }) as Session;
const pr = (jobs: WorkflowJob[], checks: GitState["checks"]): GitState => ({
  kind: "github",
  state: "open",
  number: 9,
  checks,
  deployConfigured: false,
  headSha: "abc",
  jobs,
});
/** A job running 65 min against a usual 43 → overdue. */
const overdue = () =>
  pr(
    [
      {
        name: "CI / Release-Gate",
        state: "pending",
        startedAt: Date.now() - 65 * MIN,
        typicalMs: 43 * MIN,
        url: JOB_URL,
      },
    ],
    "pending",
  );
const red = () => pr([{ name: "CI / test", state: "failure" }], "failure");
const loop: SteerLogEntry[] = [1, 2, 3].map((i) => ({
  ts: Date.now() - i * MIN,
  kind: "ci_fix",
  headSha: "abc",
}));

function mount(over: Record<string, unknown> = {}) {
  let shown = false;
  render(PulseActionBanner, {
    session: session(),
    git: overdue(),
    steers: [],
    autopilotOn: true,
    tab: "term",
    reviewActive: false,
    get shown() {
      return shown;
    },
    set shown(v: boolean) {
      shown = v;
    },
    ...over,
  });
  return { shown: () => shown };
}

const banner = () => document.querySelector<HTMLElement>(".pa-banner");
const button = (label: string) =>
  [...document.querySelectorAll<HTMLElement>(".pa-banner .pa-btn")].find(
    (b) => b.textContent?.trim() === label,
  );

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  document.body.innerHTML = "";
});

describe("PulseActionBanner", () => {
  it("CI overdue: opens the run and re-runs after a confirm click", async () => {
    const h = mount();
    await expect.poll(() => banner()?.dataset.kind).toBe("ci_overdue");
    expect(h.shown()).toBe(true);
    expect(button(m.pulseactions_open_run())?.getAttribute("href")).toBe(JOB_URL);
    button(m.pulseactions_rerun())!.click();
    await expect.poll(() => button(m.pulseactions_rerun_confirm())).toBeTruthy();
    expect(api.restartCiJob).not.toHaveBeenCalled();
    button(m.pulseactions_rerun_confirm())!.click();
    await expect.poll(() => api.restartCiJob.mock.calls.length).toBe(1);
    expect(api.restartCiJob).toHaveBeenCalledWith("s1", "CI / Release-Gate");
    await expect
      .poll(() => (button(m.pulseactions_rerun_busy()) as HTMLButtonElement | undefined)?.disabled)
      .toBe(true);
  });

  it("going in circles: take over turns autopilot off, stop interrupts", async () => {
    mount({ git: red(), steers: loop });
    await expect.poll(() => banner()?.dataset.kind).toBe("looping");
    button(m.pulseactions_take_over())!.click();
    button(m.pulseactions_stop())!.click();
    await expect.poll(() => api.interruptSession.mock.calls.length).toBe(1);
    expect(api.setSessionAutopilot).toHaveBeenCalledWith("s1", false);
    expect(api.interruptSession).toHaveBeenCalledWith("s1");
  });

  it("hides take over with autopilot off and stop when the agent isn't running", async () => {
    mount({ git: red(), steers: loop, autopilotOn: false, session: session({ status: "idle" }) });
    await expect.poll(() => banner()?.dataset.kind).toBe("looping");
    expect(button(m.pulseactions_take_over())).toBeUndefined();
    expect(button(m.pulseactions_stop())).toBeUndefined();
  });

  it("stays out of the slot for a mirrored session, under the review banner, or off the term tab", async () => {
    for (const over of [
      { session: session({ host: { name: "mac" } as Session["host"] }) },
      { reviewActive: true },
      { tab: "diff" },
    ]) {
      const h = mount(over);
      await Promise.resolve();
      expect(banner()).toBeNull();
      if (!("tab" in over)) expect(h.shown()).toBe(false);
      document.body.innerHTML = "";
    }
  });
});
