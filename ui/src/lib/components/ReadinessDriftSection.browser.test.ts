import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { DriftRow, FrameworkDrift } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";

const getFrameworkDrift = vi.fn<(repo: string) => Promise<FrameworkDrift>>();
vi.mock("#lib/api.js", () => ({
  getFrameworkDrift: (repo: string) => getFrameworkDrift(repo),
  createUpgradeStory: vi.fn(),
}));

import ReadinessDriftSection from "./ReadinessDriftSection.svelte";

const held = (hold: DriftRow["hold"]): DriftRow => ({
  ecosystem: "npm",
  name: "typescript",
  installed: "6",
  latest: "7.0.2",
  target: "7",
  state: "held",
  manifests: ["package.json"],
  hold,
  dependabot: [],
});

const drift = (rows: DriftRow[]): FrameworkDrift => ({
  rows,
  resolver: "ok",
  epicBranches: [],
  runningEpic: null,
  canCreateStory: true,
  openStory: null,
});

describe("ReadinessDriftSection intentional holds", () => {
  beforeEach(() => getFrameworkDrift.mockReset());

  it.each([
    ["alias", () => m.readiness_drift_held_alias()],
    ["dependabot", () => m.readiness_drift_held_dependabot()],
  ] as const)("%s hold shows its reason and offers no upgrade story", async (hold, reason) => {
    getFrameworkDrift.mockResolvedValue(drift([held(hold)]));
    render(ReadinessDriftSection, { props: { repoPath: "/repo" } });
    await expect.element(page.getByText(reason())).toBeVisible();
    await expect.element(page.getByText("6 → 7 (7.0.2)")).toBeVisible();
    expect(page.getByRole("status").elements()).toHaveLength(0);
    expect(page.getByRole("button", { name: m.readiness_drift_create_story() }).elements()).toEqual(
      [],
    );
  });
});
