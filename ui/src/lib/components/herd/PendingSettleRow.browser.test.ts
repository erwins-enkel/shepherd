import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../../app.css";
import PendingSettleRow from "./PendingSettleRow.svelte";
import { m } from "#lib/paraglide/messages.js";

// #3016: an open settle whose session this Shepherd's mirror does not show still gets a row.

const MAC = { instanceId: "mac-1", name: "macbook", platform: "macos" };

describe("PendingSettleRow", () => {
  it("names the machine, the child and why its settle there is open", async () => {
    render(PendingSettleRow, {
      settle: {
        repoPath: "/r",
        issueNumber: 3013,
        parentIssueNumber: 3016,
        host: MAC,
        sessionId: "mac-145",
        reason: "offline",
      },
    });
    const row = document.querySelector<HTMLElement>(".settle-row")!;
    await expect
      .poll(() => row?.getAttribute("aria-label"))
      .toBe(m.integrated_pending_row_aria({ machine: "macbook", issue: "3013" }));
    expect(row.textContent).toContain("#3013");
    expect(row.textContent).toContain(
      m.integrated_chip_remote({
        parent: "3016",
        host: "macbook",
        status: m.integrated_offline_status(),
      }),
    );
  });
});
