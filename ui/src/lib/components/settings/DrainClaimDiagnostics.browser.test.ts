import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import DrainClaimDiagnostics from "./DrainClaimDiagnostics.svelte";
import { m } from "#lib/paraglide/messages.js";

const row = {
  number: 133,
  title: "Calendar",
  url: "https://github.com/o/r/issues/133",
  ownership: "unknown",
  evidence: "complete",
  mergedPrs: [{ number: 212, url: "https://github.com/o/r/pull/212", state: "merged" }],
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function api(evidence = "complete", fail = false, over: Partial<typeof row> = {}) {
  const posts: Record<string, unknown>[] = [];
  let resolved = false;
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      resolved = !fail;
      return json(fail ? { error: "changed" } : { ok: true }, fail ? 409 : 200);
    }
    return json([
      {
        repoPath: "/repo",
        reason: "empty",
        claimDiagnostics: resolved ? [] : [{ ...row, ...over, evidence }],
      },
    ]);
  });
  return posts;
}
afterEach(() => vi.unstubAllGlobals());
describe("Drain claim diagnostics", () => {
  it("shows uncertainty and merged evidence even when reason is empty, confirms before POST", async () => {
    const posts = api();
    render(DrainClaimDiagnostics);
    await expect.element(page.getByRole("link", { name: "#133 Calendar" })).toBeVisible();
    await expect.element(page.getByText(m.drain_claims_ownership())).toBeVisible();
    await expect.element(page.getByRole("link", { name: "#212" })).toBeVisible();
    await page.getByRole("button", { name: m.drain_claims_release(), exact: true }).click();
    expect(posts).toEqual([]);
    await expect.element(page.getByText(m.drain_claims_confirm_release())).toBeVisible();
    await page.getByRole("button", { name: m.drain_claims_confirm(), exact: true }).click();
    await expect.element(page.getByRole("link", { name: "#133 Calendar" })).not.toBeInTheDocument();
    expect(posts).toEqual([
      { repoPath: "/repo", issueNumber: 133, action: "release", confirmUnknownOwnership: true },
    ]);
  });
  it("unknown PR evidence disables mutations", async () => {
    api("unknown");
    render(DrainClaimDiagnostics);
    await expect.element(page.getByText(m.drain_claims_unverified())).toBeVisible();
    expect(
      page.getByRole("button", { name: m.drain_claims_release(), exact: true }).query(),
    ).toBeNull();
  });
  it("closing has its own confirmation and exposes fresh-check conflicts", async () => {
    const posts = api("complete", true);
    render(DrainClaimDiagnostics);
    await page.getByRole("button", { name: m.drain_claims_close(), exact: true }).click();
    expect(posts).toEqual([]);
    await expect.element(page.getByText(m.drain_claims_confirm_close())).toBeVisible();
    await page.getByRole("button", { name: m.drain_claims_confirm(), exact: true }).click();
    await expect.element(page.getByText(m.drain_claims_changed())).toBeVisible();
    expect(posts[0]?.action).toBe("close");
    await expect.element(page.getByRole("link", { name: "#133 Calendar" })).toBeVisible();
  });
});

it("does not navigate to unsafe forge URL schemes", async () => {
  api("complete", false, {
    url: "javascript:alert(1)",
    mergedPrs: [{ number: 212, url: "javascript:alert(2)", state: "merged" }],
  });
  render(DrainClaimDiagnostics);
  await expect.element(page.getByText("#133 Calendar", { exact: true })).toBeVisible();
  expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
});
