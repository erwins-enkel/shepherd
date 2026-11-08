import { describe, expect, it } from "vitest";
import { m } from "#lib/paraglide/messages.js";
import {
  REPO_SETTINGS_SECTIONS,
  repoShortStatus,
  sectionLabel,
  sectionSummary,
  type SectionSnapshot,
} from "./sections";

const flags = {
  critic: true,
  criticAllPrs: false,
  smellLens: true,
  autoAddress: false,
  planGate: true,
  autopilot: false,
  autoDrain: true,
  autoMerge: false,
  buildQueue: false,
  draftMode: false,
};
const snap = (over: Partial<SectionSnapshot> = {}): SectionSnapshot => ({
  cli: "claude",
  sandbox: "autonomous",
  lightweight: false,
  flags,
  schedules: 0,
  epicStacks: false,
  preWarmEpicLandingCi: true,
  pinned: false,
  hidden: false,
  previewOpenMode: "ask",
  ...over,
});

describe("repo settings sections", () => {
  it("puts Autonomy first", () => {
    expect(REPO_SETTINGS_SECTIONS[0]).toBe("autonomy");
  });

  it("names the autonomy level, or the custom mix", () => {
    const review = { ...flags, autoAddress: true, autopilot: true, autoDrain: false };
    expect(sectionSummary("autonomy", snap({ flags: review }))).toBe(
      m.reposettings_autonomy_review(),
    );
    expect(sectionSummary("autonomy", snap({ flags: { ...review, autoDrain: true } }))).toBe(
      m.reposettings_autonomy_backlog(),
    );
    expect(
      sectionSummary("autonomy", snap({ flags: { ...review, autoDrain: true, autoMerge: true } })),
    ).toBe(m.reposettings_autonomy_full());
    const off = { ...flags, critic: false, autoDrain: false };
    expect(sectionSummary("autonomy", snap({ flags: off }))).toBe(m.reposettings_autonomy_oncall());
    expect(sectionSummary("autonomy", snap())).toBe(m.reposettings_autonomy_custom());
  });

  it("says level · CLI · merge mode for the context menus", () => {
    const full = { ...flags, autoAddress: true, autopilot: true, autoMerge: true };
    expect(repoShortStatus({ cli: "codex", lightweight: false, flags: full })).toBe(
      `${m.reposettings_autonomy_full()} · ${m.agent_provider_codex()} · ${m.automation_automerge_name()}`,
    );
    // a local-only repo never drains and has no drafts: With review, you merge
    const draft = { ...flags, autoAddress: true, autopilot: true, draftMode: true };
    expect(repoShortStatus({ cli: "claude", lightweight: true, flags: draft })).toBe(
      `${m.reposettings_autonomy_review()} · ${m.agent_provider_claude()} · ${m.reposettings_merge_mode_manual()}`,
    );
    expect(repoShortStatus({ cli: "claude", lightweight: false, flags: draft })).toBe(
      `${m.reposettings_autonomy_custom()} · ${m.agent_provider_claude()} · ${m.reposettings_merge_mode_draft()}`,
    );
  });

  it("labels every section", () => {
    for (const id of REPO_SETTINGS_SECTIONS) expect(sectionLabel(id)).not.toBe("");
  });

  it("names the CLI and sandbox for the agent environment", () => {
    expect(sectionSummary("agent", snap())).toBe(
      `${m.agent_provider_claude()} · ${m.sandbox_profile_autonomous()}`,
    );
    expect(sectionSummary("agent", snap({ cli: "codex", sandbox: null }))).toBe(
      `${m.agent_provider_codex()} · ${m.automation_sandbox_inherit_unresolved()}`,
    );
  });

  it("counts switches as their rows gate them", () => {
    expect(sectionSummary("start", snap())).toBe(m.reposettings_summary_on({ on: 2, total: 4 }));
    // Auto-Drain needs a forge
    expect(sectionSummary("start", snap({ lightweight: true }))).toBe(
      m.reposettings_summary_on({ on: 1, total: 4 }),
    );
    // the smell lens only counts with the critic on
    expect(sectionSummary("review", snap())).toBe(m.reposettings_summary_on({ on: 2, total: 4 }));
    expect(sectionSummary("review", snap({ flags: { ...flags, critic: false } }))).toBe(
      m.reposettings_summary_on({ on: 0, total: 4 }),
    );
    expect(sectionSummary("epics", snap())).toBe(m.reposettings_summary_on({ on: 1, total: 2 }));
  });

  it("says how PRs merge", () => {
    expect(sectionSummary("merge", snap())).toBe(m.reposettings_summary_merge_manual());
    expect(sectionSummary("merge", snap({ flags: { ...flags, autoMerge: true } }))).toBe(
      m.reposettings_summary_merge_auto(),
    );
    expect(sectionSummary("merge", snap({ flags: { ...flags, draftMode: true } }))).toBe(
      m.reposettings_summary_merge_draft(),
    );
    expect(sectionSummary("merge", snap({ lightweight: true }))).toBe(m.reposettings_mode_local());
  });

  it("counts schedules and stays empty until they loaded", () => {
    expect(sectionSummary("schedules", snap({ schedules: null }))).toBe("");
    expect(sectionSummary("schedules", snap())).toBe(m.reposettings_summary_schedules_none());
    expect(sectionSummary("schedules", snap({ schedules: 1 }))).toBe(
      m.reposettings_summary_schedules_one(),
    );
    expect(sectionSummary("schedules", snap({ schedules: 3 }))).toBe(
      m.reposettings_summary_schedules({ count: 3 }),
    );
  });

  it("puts pinned before hidden before the preview mode", () => {
    expect(sectionSummary("display", snap({ pinned: true, hidden: true }))).toBe(
      m.backlog_pinned_label(),
    );
    expect(sectionSummary("display", snap({ hidden: true }))).toBe(m.reposettings_summary_hidden());
    expect(sectionSummary("display", snap({ previewOpenMode: "tab" }))).toBe(
      m.preview_open_mode_tab(),
    );
  });
});
