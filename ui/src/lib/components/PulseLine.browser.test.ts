import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../app.css";
import { m } from "#lib/paraglide/messages.js";
import type { Pulse } from "#lib/session-pulse.js";
import PulseLine from "./PulseLine.svelte";

const MIN = 60_000;
const waiting: Pulse = {
  state: "waiting_ci",
  job: {
    name: "CI / Release-Gate",
    short: "Release-Gate",
    state: "pending",
    elapsedMs: 9 * MIN,
    typicalMs: 43 * MIN,
  },
  green: 6,
  total: 7,
  ciFixRun: 1,
};

describe("PulseLine", () => {
  it("shows the verdict, time against the usual, the job, green share and the loop check", async () => {
    const { container } = await render(PulseLine, { pulse: waiting, id: "u-pulse-x" });
    const text = container.textContent ?? "";
    expect(text).toContain(m.pulse_state_waiting_ci());
    expect(text).toContain(m.pulse_minutes_of({ elapsed: 9, typical: 43 }));
    expect(text).toContain(`Release-Gate · ${m.pulse_green_of({ green: 6, total: 7 })}`);
    expect(text).toContain(m.pulse_ci_fix_no_loop({ count: 1 }));
    const fill = container.querySelector<HTMLElement>(".p-bar > span")!;
    expect(parseFloat(fill.style.width)).toBeCloseTo((9 / 43) * 100, 2);
  });

  it("an overdue job fills the bar and switches to the caution hue", async () => {
    const overdue: Pulse = {
      ...waiting,
      state: "ci_overdue",
      job: { ...waiting.job!, elapsedMs: 71 * MIN },
    };
    const { container } = await render(PulseLine, { pulse: overdue, id: "u-pulse-y" });
    expect(container.querySelector(".pulse--ci_overdue")).not.toBeNull();
    expect(container.querySelector<HTMLElement>(".p-bar > span")!.style.width).toBe("100%");
  });

  it("a loop names the CI-fix run instead of a time", async () => {
    const looping: Pulse = { state: "looping", green: 0, total: 1, ciFixRun: 3 };
    const { container } = await render(PulseLine, { pulse: looping, id: "u-pulse-z" });
    expect(container.textContent).toContain(m.pulse_ci_fix_count({ count: 3 }));
    expect(container.querySelector(".p-bar")).toBeNull();
  });
});
