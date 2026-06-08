import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { BuildQueue } from "$lib/types";
import { m } from "$lib/paraglide/messages";
import { putBuildQueue } from "$lib/api";

// Mock the API so no real network calls are made.
vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    getBuildQueue: vi.fn(
      async (): Promise<BuildQueue> => ({ sessionId: "s1", steps: [], approved: false }),
    ),
    putBuildQueue: vi.fn(
      async (_, steps): Promise<BuildQueue> => ({ sessionId: "s1", steps, approved: false }),
    ),
    approveBuildQueue: vi.fn(
      async (): Promise<BuildQueue> => ({ sessionId: "s1", steps: [], approved: true }),
    ),
  };
});

const { default: BuildQueuePanel } = await import("./BuildQueuePanel.svelte");

let fontStyle: HTMLStyleElement;
beforeEach(() => {
  fontStyle = document.createElement("style");
  fontStyle.textContent = `:root {
    --font-mono: ui-monospace, monospace;
    --color-panel: #1a1a1a;
    --color-line: #333;
    --color-inset: #111;
    --color-ink: #ccc;
    --color-ink-bright: #fff;
    --color-muted: #666;
    --color-faint: #444;
    --color-amber: #f5a623;
    --color-green: #4caf50;
    --color-red: #f44336;
    --fs-meta: 12px;
    --fs-micro: 10px;
  }
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; }`;
  document.head.appendChild(fontStyle);
});
afterEach(() => {
  fontStyle.remove();
  document.body.innerHTML = "";
});

const noop = () => {};

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
    await expect.element(page.getByText(m.buildqueue_approved_header())).toBeInTheDocument();
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
