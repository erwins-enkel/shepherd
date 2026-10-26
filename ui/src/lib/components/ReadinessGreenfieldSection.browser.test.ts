import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import ReadinessGreenfieldSection from "./ReadinessGreenfieldSection.svelte";
import { m } from "#lib/paraglide/messages.js";
import type { RepoBootstrapView } from "#lib/api.js";
import type { GreenfieldReport } from "#lib/types.js";
import { repoBootstrap } from "#lib/repo-bootstrap.svelte.js";
import { greenfieldTitle } from "./readiness-greenfield-view";

const REPORT: GreenfieldReport = {
  ecosystem: "js-ts",
  score: 88,
  items: [
    { id: "stack_pinned", tier: "must", present: true, evidence: ["CLAUDE.md"] },
    { id: "ci_on_main", tier: "must", present: true, evidence: ["ci.yml"] },
    { id: "forge_settings", tier: "must", present: false, evidence: [] },
    { id: "prd", tier: "nice", present: true, evidence: ["docs/prd/"] },
  ],
  mustHavesMissing: ["forge_settings"],
  checkedAt: 1,
};

const BOOTSTRAP: RepoBootstrapView = {
  state: "active",
  phase: 4,
  overrideAt: null,
  missing: ["P4", "forge_settings"],
  suggested: false,
  next: { kind: "epic", phase: 4, sessionId: null },
};

function mockApi() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const body = url.includes("/api/readiness/greenfield") ? REPORT : BOOTSTRAP;
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

afterEach(() => vi.restoreAllMocks());

describe("ReadinessGreenfieldSection", () => {
  it("counts the gate's must-haves and leads with the red one", async () => {
    mockApi();
    render(ReadinessGreenfieldSection, { repoPath: "/gf-gate" });
    await expect
      .element(page.getByText(m.readiness_gf_summary({ green: 2, total: 3 })))
      .toBeVisible();
    await expect.element(page.getByText("88%")).not.toBeInTheDocument();
    const mustRows = page.getByRole("list").first().getByRole("listitem");
    await expect
      .element(mustRows.first().getByText(greenfieldTitle("forge_settings"), { exact: true }))
      .toBeVisible();
  });

  it("folds the nice-to-haves away; they never hold the gate", async () => {
    mockApi();
    render(ReadinessGreenfieldSection, { repoPath: "/gf-nice" });
    const summary = page.getByText(m.readiness_gf_nice_summary({ green: 1, total: 1 }));
    await expect.element(summary).toBeVisible();
    const prd = page.getByText(greenfieldTitle("prd"), { exact: true });
    await expect.element(prd).not.toBeVisible();
    await summary.click();
    await expect.element(prd).toBeVisible();
  });

  it("while bootstrapping, marks what the operator supplies", async () => {
    mockApi();
    await repoBootstrap.load("/gf-by-you");
    render(ReadinessGreenfieldSection, { repoPath: "/gf-by-you" });
    const forge = page.getByRole("listitem").filter({ hasText: greenfieldTitle("forge_settings") });
    await expect.element(forge.getByText(m.readiness_gf_by_operator())).toBeVisible();
    const ci = page.getByRole("listitem").filter({ hasText: greenfieldTitle("ci_on_main") });
    await expect.element(ci.getByText(m.readiness_gf_by_operator())).not.toBeInTheDocument();
  });
});
