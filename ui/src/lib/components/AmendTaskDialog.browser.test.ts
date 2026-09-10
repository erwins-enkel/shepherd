import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../app.css";
import { addAmendment, retractAmendment, reviewPr } from "$lib/api";
import { amendments } from "$lib/amendments.svelte";
import { reviews } from "$lib/reviews.svelte";
import { toasts } from "$lib/toasts.svelte";
import type { Session, TaskAmendment } from "$lib/types";
import { m } from "$lib/paraglide/messages";

vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    addAmendment: vi.fn(),
    retractAmendment: vi.fn(),
    reviewPr: vi.fn(),
  };
});

const { default: AmendTaskDialog } = await import("./AmendTaskDialog.svelte");

const mockAdd = vi.mocked(addAmendment);
const mockRetract = vi.mocked(retractAmendment);
const mockReviewPr = vi.mocked(reviewPr);

const SESSION = {
  id: "s1",
  name: "amend-me",
  prompt: "do the original thing",
} as unknown as Session;

const row = (over: Partial<TaskAmendment> = {}): TaskAmendment => ({
  id: "am-1",
  sessionId: "s1",
  text: "also build the gate",
  createdAt: Date.UTC(2026, 8, 10),
  retractedAt: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  amendments.map = {};
  reviews.map = {};
  reviews.reviewing = {};
  toasts.items = [];
  mockAdd.mockResolvedValue({ amendment: row(), steered: true });
  mockRetract.mockResolvedValue({ amendment: row({ retractedAt: 5 }) });
});

const props = (extra: Record<string, unknown> = {}) => ({
  session: SESSION,
  onclose: vi.fn(),
  ...extra,
});

async function type(text: string) {
  const box = page.getByRole("textbox", { name: m.amend_placeholder() });
  await box.click();
  await userEvent.type(box, text);
}

describe("AmendTaskDialog", () => {
  it("shows the original task and disables submit until there is text", async () => {
    render(AmendTaskDialog, { props: props() });
    await expect.element(page.getByText("do the original thing")).toBeInTheDocument();

    const submit = page.getByRole("button", { name: m.amend_submit(), exact: true });
    await expect.element(submit).toBeDisabled();
    await type("widen it");
    await expect.element(submit).toBeEnabled();
  });

  it("whitespace-only text does not enable submit", async () => {
    render(AmendTaskDialog, { props: props() });
    await type("   ");
    await expect
      .element(page.getByRole("button", { name: m.amend_submit(), exact: true }))
      .toBeDisabled();
  });

  it("submits the TRIMMED text and asks for a steer when a pane is live", async () => {
    render(AmendTaskDialog, { props: props({ liveness: "alive" }) });
    await type("  go ahead and build it  ");
    await page.getByRole("button", { name: m.amend_submit(), exact: true }).click();
    expect(mockAdd).toHaveBeenCalledWith("s1", "go ahead and build it", true);
  });

  it("a husk pane disables the steer checkbox and never asks the server to steer", async () => {
    render(AmendTaskDialog, { props: props({ liveness: "husk" }) });
    const box = page.getByRole("checkbox");
    await expect.element(box).toBeDisabled();
    await expect.element(page.getByText(m.amend_steer_offline())).toBeInTheDocument();

    await type("recorded only");
    await page.getByRole("button", { name: m.amend_submit(), exact: true }).click();
    expect(mockAdd).toHaveBeenCalledWith("s1", "recorded only", false);
  });

  it("reports honestly when the amendment was recorded but did NOT reach the agent", async () => {
    mockAdd.mockResolvedValue({ amendment: row(), steered: false });
    render(AmendTaskDialog, { props: props({ liveness: "alive" }) });
    await type("widen it");
    await page.getByRole("button", { name: m.amend_submit(), exact: true }).click();
    await vi.waitFor(() =>
      expect(toasts.items.map((t) => t.text)).toContain(m.amend_recorded_not_steered()),
    );
  });

  it("lists existing amendments, striking through retracted ones", async () => {
    amendments.map = {
      s1: [row({ id: "a1", text: "STANDING" }), row({ id: "a2", text: "GONE", retractedAt: 9 })],
    };
    render(AmendTaskDialog, { props: props() });
    await expect.element(page.getByText("STANDING")).toBeInTheDocument();
    // The retracted one stays in the record, struck through, with no Retract action.
    await expect.element(page.getByText("GONE")).toBeInTheDocument();
    expect(document.querySelector(".item.retracted s")?.textContent).toBe("GONE");
    expect(document.querySelectorAll(".item .link")).toHaveLength(1);
  });

  it("retracts a standing amendment", async () => {
    amendments.map = { s1: [row({ id: "a1" })] };
    render(AmendTaskDialog, { props: props() });
    await page.getByRole("button", { name: m.amend_retract(), exact: true }).click();
    expect(mockRetract).toHaveBeenCalledWith("s1", "a1");
  });

  it("offers a re-review only when a verdict already stands and none is in flight", async () => {
    const { rerender } = await render(AmendTaskDialog, { props: props() });
    expect(page.getByRole("button", { name: m.amend_rereview(), exact: true }).query()).toBeNull();

    reviews.map = { s1: { sessionId: "s1" } as never };
    await rerender(props());
    await expect
      .element(page.getByRole("button", { name: m.amend_rereview(), exact: true }))
      .toBeInTheDocument();

    // ...but not while the critic is already running.
    reviews.reviewing = { s1: true };
    await rerender(props());
    expect(page.getByRole("button", { name: m.amend_rereview(), exact: true }).query()).toBeNull();
  });

  it("a re-review the server DECLINED is surfaced as such, never as success", async () => {
    reviews.map = { s1: { sessionId: "s1" } as never };
    mockReviewPr.mockResolvedValue("skipped");
    render(AmendTaskDialog, { props: props() });
    await page.getByRole("button", { name: m.amend_rereview(), exact: true }).click();
    await vi.waitFor(() =>
      expect(toasts.items.map((t) => t.text)).toContain(m.amend_rereview_skipped()),
    );
    expect(toasts.items.map((t) => t.text)).not.toContain(m.amend_rereview_started());
  });

  it("a failed submit raises a persistent, assertive toast", async () => {
    mockAdd.mockRejectedValue(new Error("boom"));
    render(AmendTaskDialog, { props: props() });
    await type("widen it");
    await page.getByRole("button", { name: m.amend_submit(), exact: true }).click();
    await vi.waitFor(() =>
      expect(toasts.items.some((x) => x.text === m.amend_failed())).toBe(true),
    );
    const t = toasts.items.find((x) => x.text === m.amend_failed())!;
    // sticky → no countdown window at all, and assertive so it reaches a screen reader.
    expect(t.durationMs).toBeUndefined();
    expect(t.alert).toBe(true);
  });
});
