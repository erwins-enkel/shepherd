import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { tick, type ComponentProps } from "svelte";
import { page, userEvent } from "vitest/browser";
import "../../app.css";
import type { BuildQueue } from "$lib/types";
import { m } from "$lib/paraglide/messages";
import { getLocale, setLocale } from "$lib/paraglide/runtime";
import { putBuildQueue, approveBuildQueue, replySession } from "$lib/api";
import { buildQueueCollapse } from "$lib/build-queue-collapse.svelte";

// Mock the API so no real network calls are made.
vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    replySession: vi.fn(async () => {}),
    getBuildQueue: vi.fn(async (): Promise<BuildQueue> => ({
      sessionId: "s1",
      steps: [],
      approved: false,
    })),
    putBuildQueue: vi.fn(async (_, steps): Promise<BuildQueue> => ({
      sessionId: "s1",
      steps,
      approved: false,
    })),
    approveBuildQueue: vi.fn(async (): Promise<BuildQueue> => ({
      sessionId: "s1",
      steps: [],
      approved: true,
    })),
  };
});

const { default: BuildQueuePanel } = await import("./BuildQueuePanel.svelte");

beforeEach(() => {
  buildQueueCollapse.set(false);
  vi.mocked(replySession).mockReset().mockResolvedValue(undefined);
  vi.mocked(approveBuildQueue).mockClear();
});
afterEach(() => {
  document.body.innerHTML = "";
});

const noop = () => {};

// Force skips locator actionability checks, but still sends real browser pointer
// events to the coordinates, including overlays and disabled controls.
async function clickAt(panel: HTMLElement, x: number, y: number) {
  const rect = panel.getBoundingClientRect();
  await userEvent.click(panel, {
    force: true,
    position: { x: x - rect.left - panel.clientLeft, y: y - rect.top - panel.clientTop },
  });
}

describe("BuildQueuePanel — approved queue start", () => {
  it.each(["click", "keyboard"])(
    "starts an auto-approved waiting queue via %s without re-approving or bypassing planning",
    async (activation) => {
      vi.mocked(replySession).mockClear();
      vi.mocked(approveBuildQueue).mockClear();
      const queue: BuildQueue = {
        sessionId: "s1",
        approved: true,
        approvalKind: "auto",
        steps: [{ id: "a", title: "Prepare plan", status: "pending", position: 0 }],
      };
      buildQueueCollapse.set(true);
      render(BuildQueuePanel, {
        sessionId: "s1",
        enabled: true,
        queue,
        onbootstrap: noop,
        sessionStatus: "blocked",
        planPhase: "planning",
      });
      const start = page.getByRole("button", { name: "Start now", exact: true });
      await expect.element(start).toBeVisible();
      if (activation === "click") await start.click();
      else {
        start.element().focus();
        await userEvent.keyboard("{Enter}");
      }
      expect(replySession).toHaveBeenCalledOnce();
      expect(vi.mocked(replySession).mock.calls[0][0]).toBe("s1");
      expect(vi.mocked(replySession).mock.calls[0][1]).toContain("Do not implement");
      expect(approveBuildQueue).not.toHaveBeenCalled();
      expect(buildQueueCollapse.collapsed).toBe(true);
      expect(queue.approvalKind).toBe("auto");
    },
  );
});

describe("BuildQueuePanel — action lifecycle", () => {
  const waiting: BuildQueue = {
    sessionId: "s1",
    approved: true,
    approvalKind: "auto",
    steps: [{ id: "a", title: "Prepare plan", status: "pending", position: 0 }],
  };
  const props: ComponentProps<typeof BuildQueuePanel> = {
    sessionId: "s1",
    enabled: true,
    queue: waiting,
    onbootstrap: noop,
    sessionStatus: "blocked",
    planPhase: "planning",
  };

  it("labels planning approval honestly and keeps it outside the collapsed list", async () => {
    buildQueueCollapse.set(true);
    const { rerender } = await render(BuildQueuePanel, {
      ...props,
      queue: { ...waiting, approved: false },
    });
    const approve = page.getByRole("button", { name: m.buildqueue_approve_plan() });
    await expect.element(approve).toBeVisible();
    await expect.element(page.getByText(m.buildqueue_awaiting_hint())).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: m.buildqueue_approve(), exact: true }))
      .not.toBeInTheDocument();
    await approve.click();
    expect(approveBuildQueue).toHaveBeenCalledExactlyOnceWith("s1");
    expect(replySession).not.toHaveBeenCalled();
    expect(buildQueueCollapse.collapsed).toBe(true);
    await rerender({ planPhase: "executing" });
    await expect
      .element(page.getByRole("button", { name: m.buildqueue_approve(), exact: true }))
      .toBeVisible();
  });

  for (const approved of [false, true]) {
    for (const planReview of ["reviewing", "available"] as const) {
      it(`keeps ${planReview} in the plan flow (queue approved=${approved})`, async () => {
        render(BuildQueuePanel, { ...props, queue: { ...waiting, approved }, planReview });
        const hint =
          planReview === "reviewing"
            ? m.buildqueue_plan_reviewing()
            : m.buildqueue_plan_review_hint();
        await expect.element(page.getByText(hint)).toBeVisible();
        expect(document.querySelector(".bqp-action-row")).toBeNull();
        expect(replySession).not.toHaveBeenCalled();
        expect(approveBuildQueue).not.toHaveBeenCalled();
      });
    }
  }

  const inactiveCases: [string, Partial<ComponentProps<typeof BuildQueuePanel>>][] = [
    ["running session", { sessionStatus: "running" }],
    ["archived session", { sessionStatus: "archived" }],
    ["ended terminal", { terminalEnded: true }],
    ["active step", { queue: { ...waiting, steps: [{ ...waiting.steps[0], status: "active" }] } }],
    ["done step", { queue: { ...waiting, steps: [{ ...waiting.steps[0], status: "done" }] } }],
    ["all skipped", { queue: { ...waiting, steps: [{ ...waiting.steps[0], status: "skipped" }] } }],
    ["empty queue", { queue: { ...waiting, steps: [] } }],
  ];
  for (const [name, overrides] of inactiveCases) {
    it(`does not offer a start for ${name}`, async () => {
      render(BuildQueuePanel, { ...props, ...overrides, folded: true });
      expect(document.querySelector(".bqp")).toBeNull();
      expect(replySession).not.toHaveBeenCalled();
    });
  }

  for (const kind of ["start", "approve"] as const) {
    it(`keeps ${kind} failures visible and retries without parallel sends`, async () => {
      const pending = Promise.withResolvers<never>();
      const api = kind === "start" ? vi.mocked(replySession) : vi.mocked(approveBuildQueue);
      api.mockImplementationOnce(() => pending.promise);
      render(BuildQueuePanel, {
        ...props,
        queue: { ...waiting, approved: kind === "start" },
        folded: true,
      });
      const button = document.querySelector<HTMLButtonElement>(".bqp-approve")!;
      buildQueueCollapse.set(true);
      await tick();
      await userEvent.click(button);
      const rect = button.getBoundingClientRect();
      await clickAt(document.querySelector<HTMLElement>(".bqp")!, rect.left + 4, rect.top + 4);
      expect(api).toHaveBeenCalledTimes(1);
      expect(button.disabled).toBe(true);
      expect(buildQueueCollapse.collapsed).toBe(true);
      pending.reject(new Error("offline"));
      await expect.element(page.getByRole("alert")).toHaveTextContent(m.buildqueue_action_failed());
      expect(button.disabled).toBe(false);
      await page
        .getByRole("button", {
          name: kind === "start" ? m.buildqueue_start() : m.buildqueue_approve_plan(),
        })
        .click();
      expect(api).toHaveBeenCalledTimes(2);
      expect(buildQueueCollapse.collapsed).toBe(true);
      await expect.element(page.getByRole("status")).toHaveTextContent(m.buildqueue_action_sent());
    });
  }

  it("retains request feedback across progress updates but drops it on session change", async () => {
    const pending = Promise.withResolvers<void>();
    vi.mocked(replySession).mockReturnValueOnce(pending.promise);
    const { rerender } = await render(BuildQueuePanel, { ...props, folded: true });
    await page.getByRole("button", { name: m.buildqueue_start() }).click();
    await rerender({ sessionStatus: "running", enabled: false, queue: { ...waiting, steps: [] } });
    await expect.element(page.getByRole("status")).toHaveTextContent(m.buildqueue_sending());
    pending.resolve();
    await expect.element(page.getByRole("status")).toHaveTextContent(m.buildqueue_action_sent());
    await rerender({ sessionId: "s2", queue: { ...waiting, sessionId: "s2" } });
    expect(document.querySelector(".bqp")).toBeNull();
  });

  it("does not seed a different session with an old approval response", async () => {
    const pending = Promise.withResolvers<BuildQueue>();
    vi.mocked(approveBuildQueue).mockReturnValueOnce(pending.promise);
    const onbootstrap = vi.fn();
    const { rerender } = await render(BuildQueuePanel, {
      ...props,
      queue: { ...waiting, approved: false },
      onbootstrap,
    });
    await page.getByRole("button", { name: m.buildqueue_approve_plan() }).click();
    await rerender({ sessionId: "s2", queue: { ...waiting, sessionId: "s2" } });
    pending.resolve(waiting);
    await tick();
    expect(onbootstrap).not.toHaveBeenCalledWith(waiting);
    await expect.element(page.getByText(m.buildqueue_action_sent())).not.toBeInTheDocument();
  });
});

describe("BuildQueuePanel — banner hit area", () => {
  const locale = getLocale();
  const queue: BuildQueue = {
    sessionId: "s1",
    approved: true,
    approvalKind: "auto",
    steps: [{ id: "a", title: "Prepare plan", status: "pending", position: 0 }],
  };

  afterEach(async () => {
    setLocale(locale, { reload: false });
    await page.viewport(1280, 900);
  });

  for (const width of [390, 1280]) {
    it(`toggles from hint, whitespace and padding without starting the queue at ${width}px`, async () => {
      await page.viewport(width, 900);
      setLocale("de", { reload: false });
      buildQueueCollapse.set(true);
      await render(BuildQueuePanel, {
        sessionId: "s1",
        enabled: true,
        queue,
        onbootstrap: noop,
        sessionStatus: "blocked",
        planPhase: "planning",
      });
      const panel = document.querySelector<HTMLElement>(".bqp")!;
      const toggle = document.querySelector<HTMLButtonElement>(".bqp-collapse-toggle")!;
      const content = document.getElementById(toggle.getAttribute("aria-controls")!)!;
      const rect = panel.getBoundingClientRect();
      const head = toggle.getBoundingClientRect();
      const hint = document.querySelector<HTMLElement>(".bqp-hint")!.getBoundingClientRect();
      const row = document.querySelector<HTMLElement>(".bqp-action-row")!.getBoundingClientRect();
      const points = [
        ["hint text", hint.left + 8, hint.top + 8],
        ["hint whitespace", hint.right - 4, hint.bottom - 2],
        ["between rows", head.left + 20, (head.bottom + row.top) / 2],
        ["top padding", rect.left + 4, rect.top + 4],
        ["side padding", rect.right - 4, hint.top + 8],
        ["bottom padding", rect.left + 4, row.bottom + 3],
      ] as const;

      for (const [name, x, y] of points) {
        await clickAt(panel, x, y);
        await expect
          .poll(() => toggle.getAttribute("aria-expanded"), { message: name })
          .toBe("true");
        expect(content.offsetParent, name).not.toBeNull();
        await clickAt(panel, x, y);
        await expect
          .poll(() => toggle.getAttribute("aria-expanded"), { message: name })
          .toBe("false");
        expect(content.offsetParent, name).toBeNull();
      }
      expect(replySession).not.toHaveBeenCalled();
      expect(approveBuildQueue).not.toHaveBeenCalled();
    });
  }

  it("keeps keyboard disclosure, step editing and step actions independent", async () => {
    buildQueueCollapse.set(true);
    await render(BuildQueuePanel, {
      sessionId: "s1",
      enabled: true,
      queue: { ...queue, approved: false },
      onbootstrap: noop,
    });
    const toggle = document.querySelector<HTMLButtonElement>(".bqp-collapse-toggle")!;
    toggle.focus();
    await userEvent.keyboard("{Enter}");
    await expect
      .element(page.getByRole("textbox", { name: `${m.buildqueue_step_title_aria()} 1` }))
      .toBeVisible();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(toggle);
    await userEvent.keyboard(" ");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await userEvent.keyboard("{Enter}");
    const input = page.getByRole("textbox", { name: `${m.buildqueue_step_title_aria()} 1` });
    await input.click();
    await input.fill("Updated plan");
    await userEvent.keyboard("{Enter}");
    await expect.element(input).toHaveValue("Updated plan");
    await page.getByRole("button", { name: m.buildqueue_add_step(), exact: true }).click();
    expect(buildQueueCollapse.collapsed).toBe(false);
    expect(replySession).not.toHaveBeenCalled();
    expect(approveBuildQueue).not.toHaveBeenCalled();
  });
});

// Sample actual CSS colors, compositing translucent ancestor backgrounds in the browser.
function contrast(element: HTMLElement, foreground = getComputedStyle(element).color): number {
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.canvas.width = ctx.canvas.height = 1;
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--bg");
  ctx.fillRect(0, 0, 1, 1);
  const ancestors: HTMLElement[] = [];
  for (let node: HTMLElement | null = element; node; node = node.parentElement)
    ancestors.unshift(node);
  for (const node of ancestors) {
    ctx.fillStyle = getComputedStyle(node).backgroundColor;
    ctx.fillRect(0, 0, 1, 1);
  }
  function luminance() {
    const rgb = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map((v) => {
      const n = v / 255;
      return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
    });
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  }
  const bg = luminance();
  ctx.fillStyle = foreground;
  ctx.fillRect(0, 0, 1, 1);
  const fg = luminance();
  return (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05);
}

describe("BuildQueuePanel — real themes and mobile layout", () => {
  const locale = getLocale();
  afterEach(async () => {
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-contrast");
    document.documentElement.style.removeProperty("--ui-scale");
    setLocale(locale, { reload: false });
    await page.viewport(1280, 900);
  });
  for (const theme of ["light", "dark"]) {
    for (const highContrast of [false, true]) {
      for (const width of [390, 1280]) {
        it(`keeps actions readable and reachable: ${theme}, high=${highContrast}, width=${width}`, async () => {
          await page.viewport(width, width === 390 ? 844 : 900);
          document.documentElement.dataset.theme = theme;
          document.documentElement.dataset.contrast = highContrast ? "high" : "normal";
          document.documentElement.style.setProperty("--ui-scale", "1.5");
          setLocale("de", { reload: false });
          const queue: BuildQueue = {
            sessionId: "s1",
            approved: false,
            steps: Array.from({ length: 20 }, (_, i) => ({
              id: String(i),
              title: `Schritt ${i + 1}: Planung anhand der Anforderungen prüfen`,
              detail: "Die Änderungen vorbereiten und prüfen.",
              status: "pending",
              position: i,
            })),
          };
          const { rerender } = await render(BuildQueuePanel, {
            sessionId: "s1",
            enabled: true,
            queue,
            sessionStatus: "blocked",
            planPhase: "planning",
            onbootstrap: noop,
            folded: true,
          });
          const button = document.querySelector<HTMLButtonElement>(".bqp-approve")!;
          const panel = document.querySelector<HTMLElement>(".bqp")!;
          for (const selector of [
            ".bqp-approve",
            ".bqp-hint",
            ".bqp-awaiting-chip",
            ".badge-pending",
          ]) {
            expect(
              contrast(document.querySelector<HTMLElement>(selector)!),
              selector,
            ).toBeGreaterThanOrEqual(4.5);
          }
          expect(
            contrast(button, getComputedStyle(button).borderColor),
            "button border",
          ).toBeGreaterThanOrEqual(3);
          expect(panel.scrollWidth).toBeLessThanOrEqual(width);
          expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(width);
          if (width === 390)
            expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
          const list = document.querySelector<HTMLElement>(".bqp-list")!;
          expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
          list.scrollTop = 50;
          expect(list.scrollTop).toBeGreaterThan(0);
          buildQueueCollapse.set(true);
          await expect
            .element(page.getByRole("button", { name: m.buildqueue_approve_plan() }))
            .toBeVisible();
          button.focus();
          await userEvent.keyboard("{Enter}");
          expect(approveBuildQueue).toHaveBeenCalledExactlyOnceWith("s1");
          expect(buildQueueCollapse.collapsed).toBe(true);
          await rerender({ queue: { ...queue, approved: true, approvalKind: "auto" } });
          await expect
            .element(page.getByRole("button", { name: m.buildqueue_start() }))
            .toBeVisible();
          expect(
            contrast(document.querySelector<HTMLElement>(".bqp-approved")!),
          ).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  }
});

describe("BuildQueuePanel — empty state", () => {
  it("renders the empty message when flag is on but no steps", async () => {
    render(BuildQueuePanel, {
      sessionId: "s1",
      enabled: true,
      queue: { sessionId: "s1", steps: [], approved: false },
      onbootstrap: noop,
    });
    await expect.element(page.getByText(m.buildqueue_empty())).toBeInTheDocument();
  });

  it("does not render when flag is off and no steps", async () => {
    render(BuildQueuePanel, {
      sessionId: "s1",
      enabled: false,
      queue: { sessionId: "s1", steps: [], approved: false },
      onbootstrap: noop,
    });
    // panel title should not appear since it's hidden
    const panel = document.querySelector(".bqp");
    expect(panel, "panel hidden when disabled + no steps").toBeNull();
  });
});

describe("BuildQueuePanel — curation state (unapproved, with steps)", () => {
  const curationQueue: BuildQueue = {
    sessionId: "s1",
    approved: false,
    steps: [
      { id: "a", title: "Install deps", status: "pending", position: 0 },
      { id: "b", title: "Run tests", status: "pending", position: 1 },
    ],
  };

  it("renders editable inputs for each step", async () => {
    render(BuildQueuePanel, {
      sessionId: "s1",
      enabled: true,
      queue: curationQueue,
      onbootstrap: noop,
    });
    // both step title inputs should be present
    const inputs = document.querySelectorAll<HTMLInputElement>("input.bqp-title-input");
    expect(inputs.length).toBe(2);
    expect(inputs[0].value).toBe("Install deps");
    expect(inputs[1].value).toBe("Run tests");
  });

  it("renders the Approve & run button", async () => {
    render(BuildQueuePanel, {
      sessionId: "s1",
      enabled: true,
      queue: curationQueue,
      onbootstrap: noop,
    });
    await expect.element(page.getByRole("button", { name: m.buildqueue_approve() })).toBeVisible();
  });

  it("renders remove buttons for each step", async () => {
    render(BuildQueuePanel, {
      sessionId: "s1",
      enabled: true,
      queue: curationQueue,
      onbootstrap: noop,
    });
    const removeBtns = document.querySelectorAll("button.bqp-remove");
    expect(removeBtns.length).toBe(2);
  });

  it("renders Add step button", async () => {
    render(BuildQueuePanel, {
      sessionId: "s1",
      enabled: true,
      queue: curationQueue,
      onbootstrap: noop,
    });
    await expect.element(page.getByRole("button", { name: m.buildqueue_add_step() })).toBeVisible();
  });
});

describe("BuildQueuePanel — awaiting-approval affordances (unapproved + steps)", () => {
  const curationQueue: BuildQueue = {
    sessionId: "s1",
    approved: false,
    steps: [
      { id: "a", title: "Install deps", status: "pending", position: 0 },
      { id: "b", title: "Run tests", status: "pending", position: 1 },
    ],
  };

  it("shows the awaiting chip + explanatory hint and marks the panel is-awaiting", async () => {
    render(BuildQueuePanel, {
      sessionId: "s1",
      enabled: true,
      queue: curationQueue,
      onbootstrap: noop,
    });
    await expect.element(page.getByText(m.buildqueue_awaiting_chip())).toBeVisible();
    await expect.element(page.getByText(m.buildqueue_awaiting_hint())).toBeVisible();
    expect(document.querySelector(".bqp.is-awaiting"), "panel carries is-awaiting").not.toBeNull();
  });

  it("announces the awaiting status to assistive tech even when collapsed (aria-describedby → header chip)", async () => {
    render(BuildQueuePanel, {
      sessionId: "s1",
      enabled: true,
      queue: curationQueue,
      onbootstrap: noop,
    });
    const toggle = document.querySelector<HTMLButtonElement>("button.bqp-collapse-toggle")!;
    const describedby = toggle.getAttribute("aria-describedby");
    expect(describedby, "toggle describes the awaiting chip").toBeTruthy();
    const chip = document.getElementById(describedby!);
    expect(chip?.textContent).toContain(m.buildqueue_awaiting_chip());

    // Collapse: the chip lives in the always-rendered header, so its description
    // must still resolve and stay visible while the content is hidden.
    buildQueueCollapse.set(true);
    await expect
      .poll(() => document.querySelector<HTMLElement>(".bqp-content.collapsed"))
      .toBeTruthy();

    expect(toggle.getAttribute("aria-describedby"), "describedby unchanged when collapsed").toBe(
      describedby,
    );
    const chipAfter = document.getElementById(describedby!);
    expect(chipAfter, "chip still in DOM when collapsed").not.toBeNull();
    expect(chipAfter!.offsetParent, "chip still visible (header not collapsed)").not.toBeNull();
  });
});

describe("BuildQueuePanel — awaiting affordances gated off other states", () => {
  it("does not show awaiting affordances for an approved queue with steps", async () => {
    const approvedQueue: BuildQueue = {
      sessionId: "s1",
      approved: true,
      steps: [{ id: "a", title: "Install deps", status: "active", position: 0 }],
    };
    render(BuildQueuePanel, {
      sessionId: "s1",
      enabled: true,
      queue: approvedQueue,
      onbootstrap: noop,
    });
    expect(document.querySelector(".bqp.is-awaiting"), "no is-awaiting when approved").toBeNull();
    expect(document.querySelector(".bqp-awaiting-chip"), "no chip when approved").toBeNull();
    expect(document.querySelector(".bqp-hint"), "no hint when approved").toBeNull();
  });

  it("does not show awaiting affordances for an empty (unapproved, 0-step) queue", async () => {
    render(BuildQueuePanel, {
      sessionId: "s1",
      enabled: true,
      queue: { sessionId: "s1", steps: [], approved: false },
      onbootstrap: noop,
    });
    expect(document.querySelector(".bqp.is-awaiting"), "no is-awaiting when empty").toBeNull();
    expect(document.querySelector(".bqp-awaiting-chip"), "no chip when empty").toBeNull();
    expect(document.querySelector(".bqp-hint"), "no hint when empty").toBeNull();
    await expect.element(page.getByText(m.buildqueue_empty())).toBeInTheDocument();
  });
});

describe("BuildQueuePanel — title commit guards", () => {
  const curationQueue: BuildQueue = {
    sessionId: "s1",
    approved: false,
    steps: [{ id: "a", title: "Install deps", status: "pending", position: 0 }],
  };

  beforeEach(() => vi.mocked(putBuildQueue).mockClear());

  function blurTitleWith(value: string) {
    const input = document.querySelector<HTMLInputElement>("input.bqp-title-input")!;
    input.value = value;
    input.dispatchEvent(new FocusEvent("blur"));
  }

  it("does not PUT when the title is blanked (server rejects empty)", async () => {
    render(BuildQueuePanel, {
      sessionId: "s1",
      enabled: true,
      queue: curationQueue,
      onbootstrap: noop,
    });
    blurTitleWith("   ");
    expect(putBuildQueue).not.toHaveBeenCalled();
  });

  it("does not PUT when the title is unchanged (no-op)", async () => {
    render(BuildQueuePanel, {
      sessionId: "s1",
      enabled: true,
      queue: curationQueue,
      onbootstrap: noop,
    });
    blurTitleWith("Install deps");
    expect(putBuildQueue).not.toHaveBeenCalled();
  });

  it("PUTs exactly once on a real change (blur only, no double-fire)", async () => {
    render(BuildQueuePanel, {
      sessionId: "s1",
      enabled: true,
      queue: curationQueue,
      onbootstrap: noop,
    });
    blurTitleWith("Install dependencies");
    expect(putBuildQueue).toHaveBeenCalledTimes(1);
    expect(vi.mocked(putBuildQueue).mock.calls[0][1][0].title).toBe("Install dependencies");
  });
});

describe("BuildQueuePanel — approved/running state", () => {
  const approvedQueue: BuildQueue = {
    sessionId: "s1",
    approved: true,
    steps: [
      { id: "a", title: "Install deps", status: "done", position: 0 },
      { id: "b", title: "Run tests", status: "active", position: 1 },
    ],
  };

  it("renders read-only step titles (no inputs)", async () => {
    render(BuildQueuePanel, {
      sessionId: "s1",
      enabled: true,
      queue: approvedQueue,
      onbootstrap: noop,
    });
    // no editable inputs in approved mode
    const inputs = document.querySelectorAll<HTMLInputElement>("input.bqp-title-input");
    expect(inputs.length).toBe(0);
    // but step titles ARE visible as text
    await expect.element(page.getByText("Install deps")).toBeInTheDocument();
    await expect.element(page.getByText("Run tests")).toBeInTheDocument();
  });

  it("does NOT render Approve & run in approved mode", async () => {
    render(BuildQueuePanel, {
      sessionId: "s1",
      enabled: true,
      queue: approvedQueue,
      onbootstrap: noop,
    });
    const approveBtn = document.querySelector("button.bqp-approve");
    expect(approveBtn, "no approve button in approved mode").toBeNull();
  });

  it("shows the approved header text", async () => {
    render(BuildQueuePanel, {
      sessionId: "s1",
      enabled: true,
      queue: approvedQueue,
      onbootstrap: noop,
    });
    // approvedQueue has steps [done, active] and no approvalKind → operator + running
    await expect
      .element(
        page.getByText(`${m.buildqueue_approval_operator()} · ${m.buildqueue_run_running()}`),
      )
      .toBeInTheDocument();
  });

  it("shows auto-approved · queued for auto-approved queue with all pending steps", async () => {
    const autoQueuedQueue: BuildQueue = {
      sessionId: "s1",
      approved: true,
      approvalKind: "auto",
      steps: [
        { id: "a", title: "Step 1", status: "pending", position: 0 },
        { id: "b", title: "Step 2", status: "pending", position: 1 },
      ],
    };
    render(BuildQueuePanel, {
      sessionId: "s1",
      enabled: true,
      queue: autoQueuedQueue,
      onbootstrap: noop,
    });
    await expect
      .element(page.getByText(`${m.buildqueue_approval_auto()} · ${m.buildqueue_run_queued()}`))
      .toBeInTheDocument();
  });

  it("shows auto-approved · running for auto-approved queue with an active step", async () => {
    const autoRunningQueue: BuildQueue = {
      sessionId: "s1",
      approved: true,
      approvalKind: "auto",
      steps: [
        { id: "a", title: "Step 1", status: "done", position: 0 },
        { id: "b", title: "Step 2", status: "active", position: 1 },
      ],
    };
    render(BuildQueuePanel, {
      sessionId: "s1",
      enabled: true,
      queue: autoRunningQueue,
      onbootstrap: noop,
    });
    await expect
      .element(page.getByText(`${m.buildqueue_approval_auto()} · ${m.buildqueue_run_running()}`))
      .toBeInTheDocument();
  });

  it("shows approved · done for operator-approved queue with all steps done/skipped", async () => {
    const operatorDoneQueue: BuildQueue = {
      sessionId: "s1",
      approved: true,
      approvalKind: "operator",
      steps: [
        { id: "a", title: "Step 1", status: "done", position: 0 },
        { id: "b", title: "Step 2", status: "skipped", position: 1 },
      ],
    };
    render(BuildQueuePanel, {
      sessionId: "s1",
      enabled: true,
      queue: operatorDoneQueue,
      onbootstrap: noop,
    });
    await expect
      .element(page.getByText(`${m.buildqueue_approval_operator()} · ${m.buildqueue_run_done()}`))
      .toBeInTheDocument();
  });

  it("renders operator label for undefined approvalKind and auto label only for explicit auto", async () => {
    const undefinedKindQueue: BuildQueue = {
      sessionId: "s1",
      approved: true,
      steps: [{ id: "a", title: "Step 1", status: "pending", position: 0 }],
    };
    const { unmount } = await render(BuildQueuePanel, {
      sessionId: "s1",
      enabled: true,
      queue: undefinedKindQueue,
      onbootstrap: noop,
    });
    // undefined kind → renders operator label
    await expect
      .element(page.getByText(`${m.buildqueue_approval_operator()} · ${m.buildqueue_run_queued()}`))
      .toBeInTheDocument();
    // auto label must NOT appear
    const autoLabel = document.querySelector(".bqp-approved");
    expect(autoLabel?.textContent).not.toContain(m.buildqueue_approval_auto());
    unmount();

    // Now render an explicit auto queue — the auto label DOES appear
    const autoKindQueue: BuildQueue = {
      sessionId: "s1",
      approved: true,
      approvalKind: "auto",
      steps: [{ id: "a", title: "Step 1", status: "pending", position: 0 }],
    };
    render(BuildQueuePanel, {
      sessionId: "s1",
      enabled: true,
      queue: autoKindQueue,
      onbootstrap: noop,
    });
    await expect
      .element(page.getByText(`${m.buildqueue_approval_auto()} · ${m.buildqueue_run_queued()}`))
      .toBeInTheDocument();
  });

  it("renders status badges for done and active steps", async () => {
    render(BuildQueuePanel, {
      sessionId: "s1",
      enabled: true,
      queue: approvedQueue,
      onbootstrap: noop,
    });
    const doneBadges = document.querySelectorAll(".badge-done");
    const activeBadges = document.querySelectorAll(".badge-active");
    expect(doneBadges.length).toBeGreaterThan(0);
    expect(activeBadges.length).toBeGreaterThan(0);
  });
});

describe("BuildQueuePanel — collapse/expand", () => {
  const curationQueue: BuildQueue = {
    sessionId: "s1",
    approved: false,
    steps: [
      { id: "a", title: "Install deps", status: "pending", position: 0 },
      { id: "b", title: "Run tests", status: "pending", position: 1 },
    ],
  };

  it("initially expanded: content wrapper visible, inputs visible", async () => {
    render(BuildQueuePanel, {
      sessionId: "s1",
      enabled: true,
      queue: curationQueue,
      onbootstrap: noop,
    });
    const content = document.querySelector(".bqp-content");
    expect(content).not.toBeNull();
    await expect
      .element(page.getByRole("textbox", { name: `${m.buildqueue_step_title_aria()} 1` }))
      .toBeVisible();
    const toggleBtn = document.querySelector<HTMLButtonElement>("button.bqp-collapse-toggle");
    expect(toggleBtn?.getAttribute("aria-expanded")).toBe("true");
  });

  it("after collapse: content wrapper not visible, wrapper + id still in DOM, inputs not visible, aria-expanded false", async () => {
    render(BuildQueuePanel, {
      sessionId: "s1",
      enabled: true,
      queue: curationQueue,
      onbootstrap: noop,
    });

    buildQueueCollapse.set(true);
    // poll until Svelte reactivity flushes and the collapsed class appears
    await expect
      .poll(() => document.querySelector<HTMLElement>(".bqp-content.collapsed"))
      .toBeTruthy();

    // wrapper stays in the DOM with the correct id
    const content = document.querySelector<HTMLElement>(".bqp-content");
    expect(content, "wrapper stays in DOM").not.toBeNull();
    expect(content!.id).toBe("bqp-content-s1");

    // wrapper has the collapsed class applied → CSS display:none cascade hides it
    expect(content!.classList.contains("collapsed"), "collapsed class present").toBe(true);

    // wrapper itself is layout-excluded (proves display:none on .bqp-content.collapsed)
    expect(content!.offsetParent, "wrapper hidden (offsetParent null)").toBeNull();

    // each curation input is physically inside the hidden wrapper → not visible
    const inputs = document.querySelectorAll<HTMLInputElement>("input.bqp-title-input");
    expect(inputs.length, "inputs still in DOM").toBe(2);
    for (const input of inputs) {
      // offsetParent is null for elements that are not rendered (display:none on self or ancestor)
      expect(input.offsetParent, "input hidden by cascade (offsetParent null)").toBeNull();
    }

    // toggle button reports collapsed state
    const toggleBtn = document.querySelector<HTMLButtonElement>("button.bqp-collapse-toggle");
    expect(toggleBtn?.getAttribute("aria-expanded")).toBe("false");
  });

  it("after toggling back to expanded: wrapper and inputs visible, aria-expanded true", async () => {
    render(BuildQueuePanel, {
      sessionId: "s1",
      enabled: true,
      queue: curationQueue,
      onbootstrap: noop,
    });

    buildQueueCollapse.set(true);
    // wait for collapse to flush
    await expect
      .poll(() => document.querySelector<HTMLElement>(".bqp-content.collapsed"))
      .toBeTruthy();

    buildQueueCollapse.set(false);
    // wait until wrapper is layout-visible again (offsetParent non-null)
    await expect
      .poll(() => document.querySelector<HTMLElement>(".bqp-content")?.offsetParent)
      .not.toBeNull();

    // aria-expanded should reflect expanded state
    await expect
      .poll(() =>
        document
          .querySelector<HTMLButtonElement>("button.bqp-collapse-toggle")
          ?.getAttribute("aria-expanded"),
      )
      .toBe("true");

    await expect
      .element(page.getByRole("textbox", { name: `${m.buildqueue_step_title_aria()} 1` }))
      .toBeVisible();
  });

  it("clicking the header anywhere (not just the ▴ glyph) expands a collapsed queue", async () => {
    render(BuildQueuePanel, {
      sessionId: "s1",
      enabled: true,
      queue: curationQueue,
      onbootstrap: noop,
    });

    buildQueueCollapse.set(true);
    await expect
      .poll(() => document.querySelector<HTMLElement>(".bqp-content.collapsed"))
      .toBeTruthy();

    // Click the title label — NOT the ▴ glyph. The whole header is the toggle
    // button, so a click anywhere on the bar bubbles to it and expands.
    (document.querySelector(".bqp-title") as HTMLElement).click();

    await expect
      .poll(() =>
        document
          .querySelector<HTMLButtonElement>("button.bqp-collapse-toggle")
          ?.getAttribute("aria-expanded"),
      )
      .toBe("true");
    await expect
      .poll(() => document.querySelector<HTMLElement>(".bqp-content")?.offsetParent)
      .not.toBeNull();
  });
});
