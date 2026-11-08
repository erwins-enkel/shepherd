import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import { tick } from "svelte";
import "../../../app.css";
import AutomationDrainFields from "./AutomationDrainFields.svelte";
import { automationFocus } from "#lib/automation-focus.js";
import { m } from "#lib/paraglide/messages.js";
import { repoConfig } from "#lib/reviews.svelte.js";

const cap = () => page.getByRole("spinbutton", { name: m.drain_cap_label() });

afterEach(() => {
  vi.restoreAllMocks();
  automationFocus.take("max-auto");
});

// The epic detail's "Allow N slots" (#2939) opens the Automation tab at the agent-slot cap.
describe("AutomationDrainFields — focus request", () => {
  it("focuses the cap when the tab mounts on a fresh request", async () => {
    automationFocus.request("max-auto");
    render(AutomationDrainFields, { repoPath: "/repo", active: true, epicActive: true });

    await expect.element(cap()).toHaveFocus();
    // One-shot: the request is spent.
    expect(automationFocus.take("max-auto")).toBe(false);
  });

  it("leaves focus alone without a request", async () => {
    render(AutomationDrainFields, { repoPath: "/repo", active: true, epicActive: true });

    await expect.element(cap()).toBeVisible();
    await expect.element(cap()).not.toHaveFocus();
  });

  it("ignores a request that lapsed", async () => {
    const t0 = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(t0);
    automationFocus.request("max-auto");
    vi.spyOn(Date, "now").mockReturnValue(t0 + 5_000);
    render(AutomationDrainFields, { repoPath: "/repo", active: true, epicActive: true });

    await expect.element(cap()).toBeVisible();
    await expect.element(cap()).not.toHaveFocus();
  });
});

describe("AutomationDrainFields — seeding (#3443)", () => {
  it("takes the stored values once the repo config arrives after mount", async () => {
    render(AutomationDrainFields, { repoPath: "/repo/late", active: true });
    await expect.element(cap()).toHaveValue(1);
    repoConfig.maxAuto = { ...repoConfig.maxAuto, "/repo/late": 3 };
    repoConfig.loaded = { ...repoConfig.loaded, "/repo/late": true };
    await expect.element(cap()).toHaveValue(3);
  });
});

describe("AutomationDrainFields — priority labels (#3446)", () => {
  const REPO = "/repo/prio";
  const labelInput = () =>
    page.getByRole("textbox", { name: m.automation_priority_labels_label() });
  const addButton = () =>
    page.getByRole("button", { name: m.automation_priority_labels_add(), exact: true });

  afterEach(() => {
    vi.unstubAllGlobals();
    repoConfig.priorityLabels = {};
  });

  // Fake only the repo-config PUT: echo the patch back as the stored config.
  const realFetch = globalThis.fetch;
  function stubFetch() {
    const puts: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).startsWith("/api/repo-config") && init?.method === "PUT") {
          const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
          puts.push(patch);
          return Response.json(patch);
        }
        return realFetch(input, init);
      }),
    );
    return puts;
  }

  async function addLabel(value: string) {
    const input = labelInput().element() as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    (addButton().element() as HTMLButtonElement).click();
    await tick();
  }

  it("is shown only while label-drain runs: not with the rails off, nor during an epic", async () => {
    const { rerender } = await render(AutomationDrainFields, { repoPath: REPO, active: false });
    expect(labelInput().query()).toBeNull();
    await rerender({ repoPath: REPO, active: true, epicActive: true });
    await expect.element(cap()).toBeVisible();
    expect(labelInput().query()).toBeNull();
    await rerender({ repoPath: REPO, active: true, epicActive: false });
    await expect.element(labelInput()).toBeVisible();
  });

  it("leads with a fixed shepherd:priority chip that can't be removed", async () => {
    repoConfig.priorityLabels = { [REPO]: ["urgent"] };
    render(AutomationDrainFields, { repoPath: REPO, active: true });
    await expect.element(page.getByText("shepherd:priority", { exact: true })).toBeVisible();
    await expect.element(page.getByText("urgent", { exact: true })).toBeVisible();
    expect(
      page
        .getByRole("button", {
          name: m.automation_priority_labels_remove({ label: "shepherd:priority" }),
        })
        .query(),
    ).toBeNull();
    await expect
      .element(
        page.getByRole("button", {
          name: m.automation_priority_labels_remove({ label: "urgent" }),
        }),
      )
      .toBeVisible();
  });

  it("adds a trimmed label and persists the full list", async () => {
    const puts = stubFetch();
    repoConfig.priorityLabels = { [REPO]: ["urgent"] };
    render(AutomationDrainFields, { repoPath: REPO, active: true });
    await addLabel("  CI-Gate-Rot ");
    await vi.waitFor(() => expect(puts).toEqual([{ priorityLabels: ["urgent", "CI-Gate-Rot"] }]));
    await expect.element(page.getByText("CI-Gate-Rot", { exact: true })).toBeVisible();
    expect((labelInput().element() as HTMLInputElement).value).toBe("");
  });

  it("removes a label and persists the rest", async () => {
    const puts = stubFetch();
    repoConfig.priorityLabels = { [REPO]: ["urgent", "ci-gate-rot"] };
    render(AutomationDrainFields, { repoPath: REPO, active: true });
    const remove = page.getByRole("button", {
      name: m.automation_priority_labels_remove({ label: "urgent" }),
    });
    (remove.element() as HTMLButtonElement).click();
    await vi.waitFor(() => expect(puts).toEqual([{ priorityLabels: ["ci-gate-rot"] }]));
    expect(page.getByText("urgent", { exact: true }).query()).toBeNull();
  });

  it.each([
    ["   ", () => m.automation_priority_labels_err_empty()],
    ["shepherd:priority", () => m.automation_priority_labels_err_duplicate()],
    [" urgent ", () => m.automation_priority_labels_err_duplicate()],
  ])("rejects %j inline without saving", async (value, message) => {
    const puts = stubFetch();
    repoConfig.priorityLabels = { [REPO]: ["urgent"] };
    render(AutomationDrainFields, { repoPath: REPO, active: true });
    await addLabel(value);
    await expect.element(page.getByRole("alert")).toHaveTextContent(message());
    expect(labelInput().element().getAttribute("aria-invalid")).toBe("true");
    expect(puts).toEqual([]);
  });
});
