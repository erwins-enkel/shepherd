import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import type { SteeringReport, SteeringReportSnapshot } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";

const api = vi.hoisted(() => ({
  getSteeringReport: vi.fn<() => Promise<SteeringReportSnapshot>>(),
  runSteeringReport: vi.fn<() => Promise<{ running: true }>>(),
}));
vi.mock("#lib/api.js", async (orig) => ({ ...((await orig()) as object), ...api }));

const { steeringReport } = await import("#lib/steering-report.svelte.js");
const { default: SteeringLens } = await import("./SteeringLens.svelte");

const row = (key: string, n: number, thin = n < 3) => ({
  key,
  n,
  thin,
  mergedShare: 0.5,
  medianOperatorSteers: 1.5,
  medianReview: 1,
  medianCi: 0,
  medianPlanReview: 0,
  medianDurationMin: 75,
});

const report = (over: Partial<SteeringReport> = {}): SteeringReport => ({
  id: "r1",
  createdAt: Date.UTC(2026, 10, 24, 12),
  windowStart: Date.UTC(2026, 10, 17),
  windowEnd: Date.UTC(2026, 10, 24),
  trigger: "manual",
  status: "ok",
  error: null,
  model: "claude-sonnet-x",
  sample: {
    windowStart: 0,
    windowEnd: 0,
    considered: 7,
    capped: false,
    skipped: { unarchived: 3, terminal: 1, relaunch: 1, noop: 0, outOfWindow: 9 },
  },
  sessions: [
    {
      desig: "TASK-1",
      repo: "shepherd",
      origin: "typed",
      outcome: "merged",
      durationMin: 40,
      operatorSteerCount: 2,
      shepherdSteers: {},
    },
  ],
  labels: {
    prompts: [],
    steers: [],
    findings: [
      { text: "Fix-first prompts needed more corrections.", desigs: ["TASK-1", "TASK-2"] },
    ],
    examples: [
      {
        desig: "TASK-1",
        quote: "add a retry to fetchUser",
        evidence: "Three corrections followed.",
        rewrite: "Profile loads fail on flaky Wi-Fi; they should survive one dropped request.",
      },
    ],
  },
  tables: {
    byStyle: [row("describing", 4), row("prescribing", 2)],
    byType: [row("bugfix", 5)],
    intents: [
      { intent: "correction", start: 1, mid: 2, end: 0 },
      { intent: "scope", start: 0, mid: 0, end: 1 },
      { intent: "clarification", start: 0, mid: 0, end: 0 },
      { intent: "approval", start: 0, mid: 0, end: 3 },
    ],
  },
  ...over,
});

async function mount(snap: SteeringReportSnapshot) {
  api.getSteeringReport.mockResolvedValue(snap);
  render(SteeringLens);
  await vi.waitFor(() => expect(steeringReport.loaded).toBe(true));
}

beforeEach(() => {
  steeringReport.running = false;
  steeringReport.report = null;
  steeringReport.loaded = false;
  steeringReport.loadError = false;
  steeringReport.runError = false;
  api.getSteeringReport.mockReset();
  api.runSteeringReport.mockReset();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("SteeringLens", () => {
  it("renders an ok report: header, tables, intents, findings, examples with repo", async () => {
    await mount({ running: false, report: report() });

    await expect.element(page.getByText(m.usage_steering_sessions({ n: 7 }))).toBeVisible();
    // terminal + relaunch + noop; unarchived/out-of-window are not "skipped".
    await expect.element(page.getByText(m.usage_steering_skipped({ n: 2 }))).toBeVisible();
    await expect
      .element(page.getByText(m.usage_steering_model({ model: "claude-sonnet-x" })))
      .toBeVisible();

    const captions = [...document.querySelectorAll("caption")].map((c) => c.textContent?.trim());
    expect(captions).toEqual([
      m.usage_steering_by_style(),
      m.usage_steering_by_type(),
      m.usage_steering_intents_heading(),
    ]);
    const styleKeys = [...document.querySelectorAll("table")[0].querySelectorAll("tbody th")].map(
      (th) => th.textContent?.trim(),
    );
    expect(styleKeys[0]).toBe(m.usage_steering_style_describing());
    // Numbers come straight from the server row: 50 % merged, 1.5 steers, 75 min → 1h 15m.
    const cells = [
      ...document
        .querySelectorAll("table")[0]
        .querySelectorAll("tbody tr")[0]
        .querySelectorAll("td"),
    ].map((td) => td.textContent?.trim());
    expect(cells).toEqual(["4", "50%", "1.5", "1", "0", "0", "1h 15m"]);

    expect([...document.querySelectorAll(".chip")].map((c) => c.textContent)).toEqual([
      "TASK-1",
      "TASK-2",
    ]);
    expect(document.querySelector(".example .repo")?.textContent).toBe("shepherd");
    expect(document.querySelector(".example blockquote")?.textContent).toBe(
      "add a retry to fetchUser",
    );
  });

  it("dims thin rows and labels them", async () => {
    await mount({ running: false, report: report() });
    const rows = document.querySelectorAll("table")[0].querySelectorAll("tbody tr");
    expect(rows[0].classList.contains("thin")).toBe(false);
    expect(rows[1].classList.contains("thin")).toBe(true);
    expect(rows[1].textContent).toContain(m.usage_steering_thin_row());
    expect(getComputedStyle(rows[1]).color).not.toBe(getComputedStyle(rows[0]).color);
  });

  it("thin report shows the banner and still renders tables", async () => {
    await mount({
      running: false,
      report: report({ status: "thin", labels: { ...report().labels!, findings: [] } }),
    });
    await expect.element(page.getByText(m.usage_steering_thin())).toBeVisible();
    expect(document.querySelectorAll("table").length).toBe(3);
    expect(document.querySelector(".findings")).toBeNull();
  });

  it("empty report says there is nothing to report", async () => {
    await mount({
      running: false,
      report: report({ status: "empty", labels: null, tables: null }),
    });
    await expect.element(page.getByText(m.usage_steering_empty())).toBeVisible();
    expect(document.querySelector("table")).toBeNull();
  });

  it("failed report maps known codes and shows spawn-failed detail", async () => {
    await mount({
      running: false,
      report: report({ status: "failed", error: "timeout", labels: null, tables: null }),
    });
    await expect
      .element(page.getByText(m.usage_steering_err_timeout(), { exact: false }))
      .toBeVisible();
    document.body.innerHTML = "";

    steeringReport.loaded = false;
    await mount({
      running: false,
      report: report({
        status: "failed",
        error: "spawn-failed: ENOENT claude",
        labels: null,
        tables: null,
      }),
    });
    await expect
      .element(page.getByText(m.usage_steering_err_generic(), { exact: false }))
      .toBeVisible();
    await expect
      .element(page.getByText(m.usage_steering_err_detail({ detail: "ENOENT claude" })))
      .toBeVisible();
  });

  it("no report yet offers a run CTA", async () => {
    await mount({ running: false, report: null });
    await expect.element(page.getByText(m.usage_steering_none())).toBeVisible();
    expect(document.querySelectorAll("button.primary").length).toBe(2);
  });

  it("Run now posts, shows running, and renders the report when the event lands", async () => {
    api.runSteeringReport.mockResolvedValue({ running: true });
    await mount({ running: false, report: null });

    await page.getByRole("button", { name: m.usage_steering_run() }).first().click();
    expect(api.runSteeringReport).toHaveBeenCalledOnce();
    const run = document.querySelector<HTMLButtonElement>("button.run")!;
    await vi.waitFor(() => expect(run.disabled).toBe(true));
    expect(run.textContent).toContain(m.usage_steering_running());

    steeringReport.apply({ running: false, report: report() });
    await vi.waitFor(() => expect(run.disabled).toBe(false));
    await expect.element(page.getByText(m.usage_steering_by_style())).toBeVisible();
  });

  it("Copy writes the rewrite to the clipboard and confirms", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.spyOn(navigator, "clipboard", "get").mockReturnValue({ writeText } as unknown as Clipboard);
    await mount({ running: false, report: report() });

    await page
      .getByRole("button", { name: m.usage_steering_copy_aria({ desig: "TASK-1" }) })
      .click();
    expect(writeText).toHaveBeenCalledWith(report().labels!.examples[0].rewrite);
    await expect
      .element(page.getByRole("button", { name: m.usage_steering_copy_aria({ desig: "TASK-1" }) }))
      .toHaveTextContent(m.usage_steering_copied());
  });
});
