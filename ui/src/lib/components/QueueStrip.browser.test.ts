import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import type { AutoMergeStatus } from "$lib/types";
import { m } from "$lib/paraglide/messages";
import QueueStrip from "./QueueStrip.svelte";

function status(over: Partial<AutoMergeStatus> = {}): AutoMergeStatus {
  return {
    repoPath: "/repos/shop",
    enabled: true,
    state: "merge_error",
    detail: "TASK-42",
    sessionId: "session-42",
    ...over,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("QueueStrip session jumps", () => {
  it("selects the affected session when its row is clicked", async () => {
    const onselect = vi.fn();
    render(QueueStrip, { autoMerge: { shop: status() }, onselect });

    const row = page.getByRole("button", { name: /shop.*TASK-42/i });
    await userEvent.click(row);

    expect(onselect).toHaveBeenCalledOnce();
    expect(onselect).toHaveBeenCalledWith("session-42");
  });

  it("uses native button keyboard activation", async () => {
    const onselect = vi.fn();
    render(QueueStrip, { autoMerge: { shop: status() }, onselect });

    const row = page.getByRole("button", { name: /shop.*TASK-42/i });
    row.element().focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");

    expect(onselect).toHaveBeenCalledTimes(2);
    expect(onselect).toHaveBeenNthCalledWith(1, "session-42");
    expect(onselect).toHaveBeenNthCalledWith(2, "session-42");
  });

  it("keeps a status without a session id static", async () => {
    render(QueueStrip, {
      autoMerge: { shop: status({ sessionId: null, state: "rebasing", detail: "TASK-42" }) },
    });

    await expect.element(page.getByText(m.automerge_state_rebasing())).toBeInTheDocument();
    expect(document.querySelector(".qs-row")).not.toBeNull();
    expect(document.querySelector("button.qs-row")).toBeNull();
  });
});
