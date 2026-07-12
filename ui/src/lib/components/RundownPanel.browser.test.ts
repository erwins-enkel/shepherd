import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { HerdDigest, RundownEpicItem } from "$lib/types";
import { herdDigest } from "$lib/herd-digest.svelte";

const { default: RundownPanel } = await import("./RundownPanel.svelte");

const epicItem = (over: Partial<RundownEpicItem> = {}): RundownEpicItem => ({
  repo: "/home/me/work/community-map",
  parent: 875,
  title: "Docs site",
  landingPr: 908,
  stranded: false,
  ...over,
});

const digest = (over: Partial<HerdDigest> = {}): HerdDigest => ({
  dayKey: "2026-06-24",
  state: "ready",
  overnight: "",
  decisions: [],
  ciRework: [],
  train: "",
  focusNext: [],
  epicsToLand: [],
  attentionFingerprint: {},
  spawnSessionId: "spawn-1",
  cwd: "/tmp/x",
  model: null,
  spawnedAt: 0,
  generatedAt: 1000,
  updatedAt: 1000,
  ...over,
});

afterEach(() => {
  herdDigest.digest = null;
  document.body.innerHTML = "";
});

describe("RundownPanel epics-to-land (#1045)", () => {
  it("renders a Tier-1 epics-to-land deep-link with PR ref + stranded chip", async () => {
    herdDigest.digest = digest({
      epicsToLand: [epicItem({ stranded: true })],
    });
    render(RundownPanel, {});
    await expect.element(page.getByText("Docs site", { exact: false })).toBeInTheDocument();
    expect(document.querySelector(".rd-item-epic")).not.toBeNull();
    expect(document.body.textContent).toContain("PR #908");
    expect(document.querySelector(".rd-epic-stranded")).not.toBeNull();
  });

  it("renders a repairing sub-label when the epic's landing PR has a live auto-repair session", async () => {
    herdDigest.digest = digest({
      epicsToLand: [epicItem({ repairing: true })],
    });
    render(RundownPanel, {});
    await expect.element(page.getByText("Docs site", { exact: false })).toBeInTheDocument();
    expect(document.querySelector(".rd-epic-repairing")).not.toBeNull();
    expect(document.querySelector(".rd-epic-stranded")).toBeNull();
  });

  it("clicking an epic item fires onepicland(repo, parent)", async () => {
    herdDigest.digest = digest({ epicsToLand: [epicItem()] });
    const onepicland = vi.fn();
    render(RundownPanel, { onepicland });
    (document.querySelector(".rd-item-epic") as HTMLButtonElement).click();
    expect(onepicland).toHaveBeenCalledWith("/home/me/work/community-map", 875);
  });

  it("epics section renders while state is 'generating' (ground truth, not LLM output)", async () => {
    herdDigest.digest = digest({ state: "generating", epicsToLand: [epicItem()] });
    render(RundownPanel, {});
    expect(document.querySelector(".rd-item-epic")).not.toBeNull();
  });

  it("all-quiet line is suppressed when an epic is pending (ready, otherwise empty)", async () => {
    herdDigest.digest = digest({ epicsToLand: [epicItem()] });
    render(RundownPanel, {});
    // populated epics section present, but no all-quiet copy above it
    expect(document.querySelector(".rd-item-epic")).not.toBeNull();
    expect(document.body.textContent).not.toContain("All quiet");
  });

  it("all-quiet line shows when truly empty (no sessions, no epics)", async () => {
    herdDigest.digest = digest({ epicsToLand: [] });
    render(RundownPanel, {});
    await expect.element(page.getByText("All quiet", { exact: false })).toBeInTheDocument();
  });
});
