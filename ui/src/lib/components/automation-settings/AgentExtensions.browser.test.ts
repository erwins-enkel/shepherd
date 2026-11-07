import { describe, it, expect, afterEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import AgentExtensions from "./AgentExtensions.svelte";
import { m } from "#lib/paraglide/messages.js";
import { repoConfig } from "#lib/reviews.svelte.js";

// #3780: the per-repo plugin / personal-skill allowlist picker.
const REPO = "/tmp/repo";

afterEach(async () => {
  // Let a PUT still in flight ingest its answer before the next test's state is laid down.
  await new Promise((r) => setTimeout(r, 0));
  vi.unstubAllGlobals();
  repoConfig.pluginAllowlist = {};
  repoConfig.skillAllowlist = {};
});

/** Answers the picker's catalog and records every repo-config PUT body; a PUT answers the full
 *  allowlist state like the server does, so ingesting it never wipes the other list. */
function stubFetch(): Record<string, unknown>[] {
  const puts: Record<string, unknown>[] = [];
  const server: Record<string, unknown> = {
    pluginAllowlist: repoConfig.pluginAllowlistFor(REPO),
    skillAllowlist: repoConfig.skillAllowlistFor(REPO),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/agent-extensions")
        return Response.json({ plugins: ["context7@c", "vercel@v"], skills: ["tdd"] });
      if (url.startsWith("/api/repo-config") && init?.method === "PUT") {
        const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
        puts.push(patch);
        Object.assign(server, patch);
        return Response.json(server);
      }
      return Response.json({});
    }),
  );
  return puts;
}

const limitBoxes = () => page.getByRole("checkbox", { name: m.automation_agent_ext_limit() });

describe("AgentExtensions", () => {
  it("unlimited by default: no item checkboxes until the limit is on", async () => {
    stubFetch();
    render(AgentExtensions, { repoPath: REPO });
    await expect.element(limitBoxes().first()).toBeVisible();
    expect(limitBoxes().all()).toHaveLength(2);
    expect(page.getByRole("checkbox", { name: "vercel@v" }).query()).toBeNull();
  });

  it("turning the limit on seeds every installed plugin; unticking PUTs the shrunk list", async () => {
    const puts = stubFetch();
    render(AgentExtensions, { repoPath: REPO });
    await expect.element(limitBoxes().first()).toBeVisible();
    (limitBoxes().first().element() as HTMLInputElement).click();
    await vi.waitFor(() => expect(puts).toEqual([{ pluginAllowlist: ["context7@c", "vercel@v"] }]));
    const vercel = page.getByRole("checkbox", { name: "vercel@v" });
    await expect.element(vercel).toBeChecked();
    (vercel.element() as HTMLInputElement).click();
    await vi.waitFor(() => expect(puts.at(-1)).toEqual({ pluginAllowlist: ["context7@c"] }));
    await expect.element(vercel).not.toBeChecked();
  });

  it("a stale allowlisted skill shows as unavailable; limit off clears to null", async () => {
    repoConfig.skillAllowlist = { [REPO]: ["tdd", "gone"] };
    const puts = stubFetch();
    render(AgentExtensions, { repoPath: REPO });
    await expect.element(page.getByText(m.automation_agent_ext_not_installed())).toBeVisible();
    await expect.element(page.getByRole("checkbox", { name: /gone/ })).toBeChecked();
    (limitBoxes().nth(1).element() as HTMLInputElement).click();
    await vi.waitFor(() => expect(puts).toEqual([{ skillAllowlist: null }]));
  });
});
