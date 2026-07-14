import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../app.css";
import CommandBar from "./CommandBar.svelte";
import { m } from "$lib/paraglide/messages";
import { repos } from "$lib/repos.svelte";
import type { Command } from "$lib/command-registry";
import type { BlockState } from "$lib/triage";
import type { RepoEntry, Session } from "$lib/types";

function session(partial: Partial<Session> & { id: string }): Session {
  return {
    desig: "TASK-01",
    name: "task one",
    prompt: "p",
    repoPath: "/repos/alpha",
    baseBranch: "main",
    branch: "feat/x",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "h",
    herdrAgentId: "ha",
    claudeSessionId: "cs",
    model: null,
    status: "idle",
    readyToMerge: false,
    mergingSince: null,
    mergingTrainId: null,
    mergeTrainPrs: null,
    autopilotEnabled: null,
    autopilotStepCount: 0,
    autopilotPaused: false,
    autopilotComplete: false,
    autopilotQuestion: null,
    planGateEnabled: null,
    planPhase: null,
    autoMergeEnabled: null,
    autoMergeRebaseCount: 0,
    auto: false,
    sandboxApplied: null,
    sandboxDegraded: false,
    egressApplied: false,
    egressDegraded: false,
    research: false,
    epicAuthoring: false,
    issueNumber: null,
    lastState: "",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    haltReason: null,
    haltedAt: null,
    manualSteps: [],
    manualStepsAckedAt: null,
    experimentId: null,
    experimentRole: null,
    ...partial,
  } as Session;
}

function seedRepos(): RepoEntry[] {
  // beta has the higher lastUsedAt → sorts before alpha. gamma has NO live session
  // (no seedSessions entry references it), so its filter affordance/action is inert.
  return [
    {
      // Symlinked repo root: entry path differs from realPath. session s1.repoPath is
      // the realpath'd form ("/repos/alpha"), matching realPath — so the filter action
      // must key on realPath, while the backlog (onselectrepo) keys on the raw path.
      name: "alpha",
      path: "/repos/alpha-link",
      display: "~/repos/alpha",
      realPath: "/repos/alpha",
      lastUsedAt: 100,
    },
    {
      name: "beta",
      path: "/repos/beta",
      display: "~/repos/beta",
      realPath: "/repos/beta",
      lastUsedAt: 200,
    },
    {
      name: "gamma",
      path: "/repos/gamma",
      display: "~/repos/gamma",
      realPath: "/repos/gamma",
      lastUsedAt: 50,
    },
  ];
}

// s2 ("newer") has the higher updatedAt → sorts before s1 ("older").
function seedSessions(): Session[] {
  return [
    session({ id: "s1", name: "older", repoPath: "/repos/alpha", updatedAt: 10 }),
    session({ id: "s2", name: "newer", repoPath: "/repos/beta", updatedAt: 20 }),
  ];
}

function block(since = 1): BlockState {
  return { reason: { shape: "awaiting-input", options: [], tail: [] }, since };
}

function renderBar(overrides: Partial<Parameters<typeof CommandBar>[1]> = {}) {
  const onselectsession = vi.fn();
  const onselectrepo = vi.fn();
  const onfilterrepo = vi.fn();
  const onselectlens = vi.fn();
  const onclose = vi.fn();
  render(CommandBar, {
    sessions: seedSessions(),
    workingBlocked: {},
    commands: [],
    onselectsession,
    onselectrepo,
    onfilterrepo,
    onselectlens,
    onclose,
    ...overrides,
  });
  return { onselectsession, onselectrepo, onfilterrepo, onselectlens, onclose };
}

beforeEach(() => {
  repos.entries = seedRepos();
});

describe("CommandBar — grouping & recency", () => {
  it("renders the three groups and recency-orders each", async () => {
    renderBar();
    // Group headers present.
    await expect.element(page.getByText(m.commandbar_group_sessions())).toBeVisible();
    await expect.element(page.getByText(m.commandbar_group_repos())).toBeVisible();
    await expect.element(page.getByText(m.commandbar_group_lenses())).toBeVisible();
    // First option is the most-recently-updated session ("newer" = s2).
    await expect.element(page.getByRole("option").first()).toHaveTextContent("newer");
  });

  it("promotes blocks-backed sessions above newer waiting sessions", async () => {
    renderBar({
      sessions: [
        session({ id: "waiting", name: "reviewer-cli-metadata", status: "done", updatedAt: 99 }),
        session({ id: "blocked", name: "needs-input", status: "blocked", updatedAt: 10 }),
      ],
      blocks: { blocked: block() },
    });

    const first = page.getByRole("option").first();
    await expect.element(first).toHaveTextContent("needs-input");
    await expect.element(first).toHaveTextContent(m.status_blocked());
  });

  it("promotes held-style blocked sessions through blocks alone", async () => {
    renderBar({
      sessions: [
        session({ id: "waiting", name: "reviewer-cli-metadata", status: "done", updatedAt: 99 }),
        session({ id: "held", name: "held-needs-input", status: "blocked", updatedAt: 10 }),
      ],
      blocks: { held: block() },
    });

    await expect.element(page.getByRole("option").first()).toHaveTextContent("held-needs-input");
  });

  it("does not promote working-while-blocked sessions even with a block entry", async () => {
    renderBar({
      sessions: [
        session({ id: "waiting", name: "reviewer-cli-metadata", status: "done", updatedAt: 99 }),
        session({ id: "working", name: "working-needs-input", status: "blocked", updatedAt: 10 }),
      ],
      workingBlocked: { working: true },
      blocks: { working: block() },
    });

    const first = page.getByRole("option").first();
    await expect.element(first).toHaveTextContent("reviewer-cli-metadata");
    await expect.element(first).toHaveTextContent(m.status_done());
  });

  it("promotes autopilot-paused sessions and explains them with the needs-you label", async () => {
    renderBar({
      sessions: [
        session({ id: "waiting", name: "reviewer-cli-metadata", status: "done", updatedAt: 99 }),
        session({
          id: "paused",
          name: "autopilot-paused",
          status: "done",
          autopilotPaused: true,
          updatedAt: 10,
        }),
      ],
    });

    const first = page.getByRole("option").first();
    await expect.element(first).toHaveTextContent("autopilot-paused");
    await expect
      .element(first)
      .toHaveTextContent(m.session_autopilot_paused_label().toLocaleUpperCase());
    expect(first.element().textContent).not.toContain(m.status_done());
  });

  it("filters fuzzily across sessions, repos and lenses", async () => {
    renderBar();
    // "rundown" surfaces the rundown lens; no seeded session/repo carries that text, so the
    // Sessions and Repositories groups drop out entirely. (Docs match by keyword and are out
    // of scope here — asserted separately in the Docs group tests.)
    await page.getByRole("combobox").fill("rundown");
    await expect
      .element(page.getByRole("option", { name: new RegExp(m.herd_seg_rundown()) }))
      .toBeVisible();
    expect(page.getByText(m.commandbar_group_sessions()).elements()).toHaveLength(0);
    expect(page.getByText(m.commandbar_group_repos()).elements()).toHaveLength(0);
  });

  it("shows the empty state when nothing matches", async () => {
    renderBar();
    await page.getByRole("combobox").fill("zzzznomatch");
    await expect.element(page.getByText(m.commandbar_no_matches())).toBeVisible();
    expect(page.getByRole("option").elements()).toHaveLength(0);
  });
});

describe("CommandBar — fuzzy matching", () => {
  it("matches a non-contiguous subsequence", async () => {
    renderBar();
    // "nwr" is a subsequence of "newer" (n·e·w·e·r) — which a substring filter would miss —
    // but not of "older", so the fuzzy matcher surfaces the former and drops the latter.
    await page.getByRole("combobox").fill("nwr");
    await expect.element(page.getByRole("option", { name: /newer/ })).toBeVisible();
    expect(page.getByRole("option", { name: /older/ }).elements()).toHaveLength(0);
  });

  it("ranks the best match first, ahead of a more-recent weaker match", async () => {
    // "deploy" is a whole-word prefix of d1 but starts mid-word in the more-recent d2 —
    // the higher-scoring d1 must win despite d2's larger updatedAt.
    const { onselectsession } = renderBar({
      sessions: [
        session({ id: "d1", name: "deploy", updatedAt: 10 }),
        session({ id: "d2", name: "redeploy", updatedAt: 99 }),
      ],
    });
    await page.getByRole("combobox").fill("deploy");
    await userEvent.keyboard("{Enter}");
    expect(onselectsession).toHaveBeenCalledWith("d1");
  });

  it("surfaces a session matched only by its prompt, with a 'matches description' affordance", async () => {
    renderBar({
      sessions: [session({ id: "p1", name: "zeta", prompt: "implement oauth login flow" })],
    });
    // "oauth" is absent from the title/desig/repo but present in the prompt (description).
    await page.getByRole("combobox").fill("oauth");
    await expect.element(page.getByRole("option", { name: /zeta/ })).toBeVisible();
    await expect.element(page.getByText(m.commandbar_prompt_match())).toBeVisible();
  });

  it("highlights matched characters without altering the option's accessible name", async () => {
    renderBar();
    await page.getByRole("combobox").fill("nw");
    // Matched letters are wrapped for highlighting…
    expect(document.querySelectorAll("mark.cb-hl").length).toBeGreaterThan(0);
    // …yet the option still reads as the full, untouched title.
    await expect.element(page.getByRole("option").first()).toHaveTextContent("newer");
  });

  it("does not stitch one fuzzy match across separate session fields", async () => {
    renderBar({
      sessions: [session({ id: "cross", name: "ne", desig: "w", repoPath: "/repos/none" })],
    });

    await page.getByRole("combobox").fill("new");

    expect(page.getByRole("option", { name: /^ne\b/ }).elements()).toHaveLength(0);
  });

  it("rejects a long-gap fuzzy title match in the command bar", async () => {
    renderBar({
      sessions: [session({ id: "wide", name: "attachment-hover-preview" })],
    });

    await page.getByRole("combobox").fill("new");

    expect(page.getByRole("option", { name: /attachment-hover-preview/ }).elements()).toHaveLength(
      0,
    );
  });

  it("shows a designation when it is the winning session field", async () => {
    renderBar({
      sessions: [session({ id: "desig", name: "alpha", desig: "TASK-99" })],
    });

    await page.getByRole("combobox").fill("task-99");

    await expect.element(page.getByRole("option", { name: /alpha/ })).toHaveTextContent("TASK-99");
  });

  it("highlights the repository name when it is the winning session field", async () => {
    renderBar({
      sessions: [session({ id: "repo", name: "zeta", repoPath: "/repos/alpha" })],
    });

    await page.getByRole("combobox").fill("alpha");

    const row = page.getByRole("option", { name: /zeta/ });
    await expect.element(row).toBeVisible();
    expect(row.element().querySelector(".cb-sub mark.cb-hl")?.textContent).toBe("alpha");
    expect(page.getByRole("option", { name: /alpha/ }).elements()).toHaveLength(2);
  });
});

describe("CommandBar — selection", () => {
  it("Enter on the first option opens the most-recent session", async () => {
    const { onselectsession } = renderBar();
    await page.getByRole("combobox").click();
    await userEvent.keyboard("{Enter}");
    expect(onselectsession).toHaveBeenCalledWith("s2");
  });

  it("ArrowDown skips group headers — landing on a repo fires onselectrepo", async () => {
    // options: [s2, s1, (Repositories header), beta, alpha, (Lenses header), next…]
    // Two ArrowDowns from idx0 → idx2 = beta. If headers were roving targets, idx2
    // would be the header and Enter would no-op — so this asserts header-skipping.
    const { onselectrepo, onselectsession } = renderBar();
    await page.getByRole("combobox").click();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onselectrepo).toHaveBeenCalledWith("/repos/beta");
    expect(onselectsession).not.toHaveBeenCalled();
  });

  it("clicking a lens row fires onselectlens", async () => {
    const { onselectlens } = renderBar();
    await page.getByRole("option", { name: new RegExp(m.herd_seg_owed()) }).click();
    expect(onselectlens).toHaveBeenCalledWith("owed");
  });
});

describe("CommandBar — repo secondary action (filter)", () => {
  // options at rest: [s2, s1, (Repos header), beta, alpha, gamma, (Lenses header)…].
  // Two ArrowDowns from idx0 lands on beta (idx2) — a repo WITH a live session.
  it("Shift+Enter on a live-session repo filters instead of selecting", async () => {
    const { onfilterrepo, onselectrepo } = renderBar();
    await page.getByRole("combobox").click();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onfilterrepo).toHaveBeenCalledWith("/repos/beta");
    expect(onselectrepo).not.toHaveBeenCalled();
  });

  it("Cmd+Enter on a live-session repo filters", async () => {
    const { onfilterrepo, onselectrepo } = renderBar();
    await page.getByRole("combobox").click();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    expect(onfilterrepo).toHaveBeenCalledWith("/repos/beta");
    expect(onselectrepo).not.toHaveBeenCalled();
  });

  it("Ctrl+Enter on a live-session repo filters", async () => {
    const { onfilterrepo, onselectrepo } = renderBar();
    await page.getByRole("combobox").click();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(onfilterrepo).toHaveBeenCalledWith("/repos/beta");
    expect(onselectrepo).not.toHaveBeenCalled();
  });

  it("plain Enter on a repo still selects it (opens backlog), never filters", async () => {
    const { onselectrepo, onfilterrepo } = renderBar();
    await page.getByRole("combobox").click();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onselectrepo).toHaveBeenCalledWith("/repos/beta");
    expect(onfilterrepo).not.toHaveBeenCalled();
  });

  // gamma (idx4) has no live session → the modifier is inert and falls back to select.
  it("Shift+Enter on a session-less repo falls back to selecting", async () => {
    const { onselectrepo, onfilterrepo } = renderBar();
    await page.getByRole("combobox").click();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onselectrepo).toHaveBeenCalledWith("/repos/gamma");
    expect(onfilterrepo).not.toHaveBeenCalled();
  });

  // alpha (idx3) is a symlinked repo: entry path "/repos/alpha-link" ≠ realPath
  // "/repos/alpha", and s1.repoPath is the realpath'd "/repos/alpha". The filter must
  // apply the realPath (what the herd repoFilter compares against), not the raw path.
  it("filters on the realPath for a symlinked repo root", async () => {
    const { onfilterrepo, onselectrepo } = renderBar();
    await page.getByRole("combobox").click();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onfilterrepo).toHaveBeenCalledWith("/repos/alpha");
    expect(onselectrepo).not.toHaveBeenCalled();
  });

  it("still opens the backlog on the raw path for a symlinked repo root", async () => {
    const { onselectrepo, onfilterrepo } = renderBar();
    await page.getByRole("combobox").click();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
    expect(onselectrepo).toHaveBeenCalledWith("/repos/alpha-link");
    expect(onfilterrepo).not.toHaveBeenCalled();
  });

  it("shows the filter hint on live-session repos but not on session-less ones", async () => {
    renderBar();
    // A live repo (beta) row carries both the "Repository" label and the ⇧↵ hint.
    await page.getByRole("combobox").fill("beta");
    const betaRow = page.getByRole("option", {
      name: new RegExp(m.commandbar_repo_affordance()),
    });
    await expect.element(betaRow).toHaveTextContent(m.commandbar_repo_filter_affordance());
    // The session-less repo (gamma) keeps "Repository" but shows no filter hint.
    await page.getByRole("combobox").fill("gamma");
    const gammaRow = page.getByRole("option").first();
    await expect.element(gammaRow).toHaveTextContent(m.commandbar_repo_affordance());
    expect(gammaRow.element().textContent).not.toContain(m.commandbar_repo_filter_affordance());
  });
});

describe("CommandBar — demo showcase seeding", () => {
  it("initialFilter seeds the input and filters the options (demo showcase invariant)", async () => {
    // "newer" matches only session s2's name — nothing else in the fixture data.
    renderBar({ initialFilter: "newer" });
    await expect.element(page.getByRole("combobox")).toHaveValue("newer");
    const opts = page.getByRole("option");
    expect(opts.elements()).toHaveLength(1);
    await expect.element(opts.first()).toHaveTextContent("newer");
  });

  it("without initialFilter the filter stays empty (inert by default)", async () => {
    renderBar();
    await expect.element(page.getByRole("combobox")).toHaveValue("");
    // All rows present — unfiltered.
    expect(page.getByRole("option").elements().length).toBeGreaterThan(1);
  });
});

describe("CommandBar — dismissal", () => {
  it("Escape closes", async () => {
    const { onclose } = renderBar();
    await page.getByRole("combobox").click();
    await userEvent.keyboard("{Escape}");
    expect(onclose).toHaveBeenCalled();
  });

  it("the close button closes", async () => {
    const { onclose } = renderBar();
    await page.getByRole("button", { name: m.common_close() }).click();
    expect(onclose).toHaveBeenCalled();
  });
});

function seedCommands(run = vi.fn()): { commands: Command[]; run: ReturnType<typeof vi.fn> } {
  const commands: Command[] = [
    { id: "broadcast", label: () => "Broadcast", run },
    // keyword-only match: label has no "cost", but the synonyms do.
    { id: "usage", label: () => "Usage", keywords: () => "cost spend tokens", run: vi.fn() },
  ];
  return { commands, run };
}

describe("CommandBar — Commands group", () => {
  it("renders a Commands group and filters on label AND keyword synonyms", async () => {
    const { commands } = seedCommands();
    renderBar({ commands });
    // "cost" matches the Usage command only via its keywords (not its label).
    await page.getByRole("combobox").fill("cost");
    await expect.element(page.getByText(m.commandbar_group_commands())).toBeVisible();
    const opts = page.getByRole("option");
    await expect.element(opts.first()).toHaveTextContent("Usage");
    expect(opts.elements()).toHaveLength(1);
  });

  it("hides Commands and Docs until a query is typed (no flood on open)", async () => {
    const { commands } = seedCommands();
    renderBar({ commands });
    // Open state: only the navigation groups show; no Commands/Docs headers or rows.
    await expect.element(page.getByText(m.commandbar_group_sessions())).toBeVisible();
    expect(page.getByText(m.commandbar_group_commands()).elements()).toHaveLength(0);
    expect(page.getByText(m.commandbar_group_docs()).elements()).toHaveLength(0);
    // No doc affordance row is present at rest either.
    expect(
      page.getByRole("option", { name: new RegExp(m.commandbar_docs_affordance()) }).elements(),
    ).toHaveLength(0);
  });

  it("selecting a command runs it and closes the bar", async () => {
    const { commands, run } = seedCommands();
    const { onclose } = renderBar({ commands });
    await page.getByRole("combobox").fill("broadcast");
    await page.getByRole("option", { name: /Broadcast/ }).click();
    expect(run).toHaveBeenCalledTimes(1);
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it("puts a stronger command match ahead of weaker navigation groups", async () => {
    const run = vi.fn();
    const commands: Command[] = [{ id: "new-task", label: () => m.commandbar_cmd_new_task(), run }];
    const { onclose, onselectsession } = renderBar({
      sessions: [session({ id: "fuzzy", name: "n-e-w" })],
      commands,
    });

    await page.getByRole("combobox").fill("new");

    const first = page.getByRole("option").first();
    await expect.element(first).toHaveTextContent(m.commandbar_cmd_new_task());
    expect(document.querySelector(".cb-group")?.textContent).toBe(m.commandbar_group_commands());
    expect(
      page
        .getByRole("option", { name: new RegExp(m.commandbar_cmd_new_task()) })
        .element()
        .querySelector("mark.cb-hl")?.textContent,
    ).toBe("New");

    await userEvent.keyboard("{Enter}");
    expect(run).toHaveBeenCalledTimes(1);
    expect(onclose).toHaveBeenCalledTimes(1);
    expect(onselectsession).not.toHaveBeenCalled();
  });

  it("keeps an exact session title ahead of a prefix command match", async () => {
    const run = vi.fn();
    const commands: Command[] = [{ id: "new-task", label: () => m.commandbar_cmd_new_task(), run }];
    const { onselectsession } = renderBar({
      sessions: [session({ id: "exact", name: "new" })],
      commands,
    });

    await page.getByRole("combobox").fill("new");
    await userEvent.keyboard("{Enter}");

    expect(onselectsession).toHaveBeenCalledWith("exact");
    expect(run).not.toHaveBeenCalled();
  });

  it("surfaces a learnings-style command via its keyword synonyms and runs it on activation", async () => {
    const run = vi.fn();
    const commands: Command[] = [
      { id: "learnings", label: () => "Learnings", keywords: () => "insights", run },
    ];
    const { onclose } = renderBar({ commands });
    // "learn" matches the label; the row surfaces in the Commands group.
    await page.getByRole("combobox").fill("learn");
    await expect.element(page.getByText(m.commandbar_group_commands())).toBeVisible();
    const opts = page.getByRole("option");
    await expect.element(opts.first()).toHaveTextContent("Learnings");
    expect(opts.elements()).toHaveLength(1);

    await page.getByRole("option", { name: /Learnings/ }).click();
    expect(run).toHaveBeenCalledTimes(1);
    expect(onclose).toHaveBeenCalledTimes(1);
  });
});

describe("CommandBar — Docs group", () => {
  it("matches a non-title query via the keyword haystack", async () => {
    renderBar();
    // "sandbox" appears in doc keywords (Configuration / Security), never a title.
    await page.getByRole("combobox").fill("sandbox");
    await expect.element(page.getByText(m.commandbar_group_docs())).toBeVisible();
    await expect
      .element(
        page.getByRole("option", { name: new RegExp(m.commandbar_docs_affordance()) }).first(),
      )
      .toBeVisible();
  });

  it("selecting a doc opens it in a new tab and closes the bar", async () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    const { onclose } = renderBar();
    await page.getByRole("combobox").fill("getting started");
    await page.getByRole("option", { name: /Getting started/ }).click();
    expect(openSpy).toHaveBeenCalledWith(
      "https://docs.shepherd.run/getting-started/",
      "_blank",
      "noopener,noreferrer",
    );
    expect(onclose).toHaveBeenCalledTimes(1);
    openSpy.mockRestore();
  });
});

describe("CommandBar — All lens", () => {
  it("includes the All lens and selecting it fires onselectlens('all')", async () => {
    const { onselectlens } = renderBar();
    await page.getByRole("combobox").fill(m.herd_seg_all());
    await page.getByRole("option", { name: new RegExp(m.herd_seg_all()) }).click();
    expect(onselectlens).toHaveBeenCalledWith("all");
  });
});

describe("CommandBar — Alt+digit quick-jump", () => {
  // Seeded open state = eleven selectable rows; only the first ten (oid 0–9) get a digit badge:
  //   0 s2 "newer" · 1 s1 "older" · 2 beta · 3 alpha · 4 gamma · 5 all · 6 next · 7 ready ·
  //   8 done · 9 rundown · (10 owed — beyond the tenth, no badge)
  it("reveals digit hints on the first ten rows only while Alt is held", async () => {
    renderBar();
    await page.getByRole("combobox").click();
    expect(document.querySelectorAll(".cb-kbd")).toHaveLength(0);

    await userEvent.keyboard("{Alt>}");
    await vi.waitFor(() =>
      expect([...document.querySelectorAll(".cb-kbd")].map((b) => b.textContent)).toEqual([
        "1",
        "2",
        "3",
        "4",
        "5",
        "6",
        "7",
        "8",
        "9",
        "0",
      ]),
    );
    await userEvent.keyboard("{/Alt}");
    await vi.waitFor(() => expect(document.querySelectorAll(".cb-kbd")).toHaveLength(0));
  });

  it("Alt+1 opens the most-recent session via onselectsession", async () => {
    const { onselectsession } = renderBar();
    await page.getByRole("combobox").click();
    await userEvent.keyboard("{Alt>}1{/Alt}");
    expect(onselectsession).toHaveBeenCalledWith("s2");
  });

  it("Alt+3 jumps to the first repo via onselectrepo", async () => {
    const { onselectrepo, onselectsession } = renderBar();
    await page.getByRole("combobox").click();
    await userEvent.keyboard("{Alt>}3{/Alt}");
    expect(onselectrepo).toHaveBeenCalledWith("/repos/beta");
    expect(onselectsession).not.toHaveBeenCalled();
  });

  it("Alt+0 jumps to the tenth row (rundown lens) via onselectlens", async () => {
    const { onselectlens } = renderBar();
    await page.getByRole("combobox").click();
    await userEvent.keyboard("{Alt>}0{/Alt}");
    expect(onselectlens).toHaveBeenCalledWith("rundown");
  });

  it("jumps regardless of focused element — e.g. Alt+1 from the ✕ button", async () => {
    // Reveal is window-scoped, so the jump is too: it must fire even when focus is on a
    // non-input element inside the dialog (here the close button), not only the search field.
    const { onselectsession, onclose } = renderBar();
    const closeBtn = document.querySelector("button.x") as HTMLButtonElement;
    closeBtn.focus();
    closeBtn.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "Digit1",
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(onselectsession).toHaveBeenCalledWith("s2");
    expect(onclose).not.toHaveBeenCalled();
  });

  it("on an empty result set, Alt+digit is preventDefaulted and fires nothing", async () => {
    // With no rows, the combo must still be swallowed so no macOS Option-glyph leaks into the
    // field. A manual dispatch lets us read defaultPrevented directly.
    const { onselectlens, onselectsession, onselectrepo } = renderBar();
    await page.getByRole("combobox").fill("zzzznomatch");
    await expect.element(page.getByText(m.commandbar_no_matches())).toBeVisible();
    const input = document.querySelector(".cb-input") as HTMLInputElement;
    const ev = new KeyboardEvent("keydown", {
      code: "Digit5",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(onselectlens).not.toHaveBeenCalled();
    expect(onselectsession).not.toHaveBeenCalled();
    expect(onselectrepo).not.toHaveBeenCalled();
  });

  it("exposes each shortcut to assistive tech via aria-keyshortcuts", async () => {
    renderBar();
    await expect.element(page.getByRole("option").first()).toBeVisible();
    const rows = [...document.querySelectorAll(".cb-row")];
    expect(rows[0].getAttribute("aria-keyshortcuts")).toBe("Alt+1");
    expect(rows[9].getAttribute("aria-keyshortcuts")).toBe("Alt+0");
    // The eleventh row is past the tenth — no shortcut, no badge.
    expect(rows[10].getAttribute("aria-keyshortcuts")).toBeNull();
  });
});

// ── two-step arm for destructive commands ──
// A destructive verb (the real one is Decommission) carries a confirmLabel + confirmAria, which is
// what makes the row two-step. Every test drives the real component contract: arm, then confirm.
const CONFIRM = m.commandbar_cmd_decommission_confirm();
const CONFIRM_ARIA = m.commandbar_cmd_decommission_confirm_aria({ desig: "TASK-07" });

function seedDestructive(run = vi.fn()): { commands: Command[]; run: ReturnType<typeof vi.fn> } {
  return {
    commands: [
      {
        id: "decommission",
        label: () => "Decommission TASK-07",
        keywords: () => "archive remove",
        confirmLabel: () => CONFIRM,
        confirmAria: () => CONFIRM_ARIA,
        run,
      },
    ],
    run,
  };
}

/** The dwell (300ms) drops a confirm that lands implausibly fast — a real operator's second
 *  keystroke never does, but a test's does. Wait it out before every legitimate confirm. */
const pastDwell = () => new Promise((r) => setTimeout(r, 320));

const decomRow = () => page.getByRole("option", { name: /Decommission|Confirm/ });
const srText = () => document.querySelector(".sr-only")?.textContent?.trim() ?? "";

describe("CommandBar — destructive command two-step arm", () => {
  it("arms on the first Enter (red row + spoken target) and fires only on the second", async () => {
    const { commands, run } = seedDestructive();
    const { onclose } = renderBar({ commands });
    await page.getByRole("combobox").fill("decom");

    await userEvent.keyboard("{Enter}");
    // Armed: the row swaps to the confirm copy, nothing has run, the bar stays open.
    await expect.element(decomRow()).toHaveTextContent(CONFIRM);
    expect(decomRow().element().classList.contains("armed")).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(onclose).not.toHaveBeenCalled();
    // The announcement names the target — the short visible label drops it.
    await vi.waitFor(() => expect(srText()).toBe(CONFIRM_ARIA));

    await pastDwell();
    await userEvent.keyboard("{Enter}");
    expect(run).toHaveBeenCalledTimes(1);
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it("does not push the confirm copy into the visible empty region (no duplicate line)", async () => {
    const { commands } = seedDestructive();
    renderBar({ commands });
    await page.getByRole("combobox").fill("decom");
    await userEvent.keyboard("{Enter}");

    await vi.waitFor(() => expect(srText()).toBe(CONFIRM_ARIA));
    const empty = document.querySelector(".cb-empty")!;
    expect(empty.textContent?.trim()).toBe("");
    expect(empty.classList.contains("filled")).toBe(false);
  });

  it("arm-by-click then confirm-by-click fires exactly once", async () => {
    const { commands, run } = seedDestructive();
    const { onclose } = renderBar({ commands });
    await page.getByRole("combobox").fill("decom");

    await decomRow().click();
    await expect.element(decomRow()).toHaveTextContent(CONFIRM);
    expect(run).not.toHaveBeenCalled();

    await pastDwell();
    await decomRow().click();
    expect(run).toHaveBeenCalledTimes(1);
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it("arming by click moves the cursor onto the row, so a following Enter confirms THAT row", async () => {
    // Rows have no hover handler, so a click never touches activeIdx on its own. Without the
    // cursor sync, this Enter would fire options[activeIdx] — a different, unarmed command.
    const run = vi.fn();
    const other = vi.fn();
    const commands: Command[] = [
      { id: "usage", label: () => "Decommission decoy", run: other },
      {
        id: "decommission",
        label: () => "Decommission TASK-07",
        confirmLabel: () => CONFIRM,
        confirmAria: () => CONFIRM_ARIA,
        run,
      },
    ];
    renderBar({ commands });
    await page.getByRole("combobox").fill("decommission");

    const rows = page.getByRole("option");
    // The decoy ranks first; the destructive row is NOT the cursor before the click.
    expect(rows.elements()[0].getAttribute("aria-selected")).toBe("true");
    const armed = page.getByRole("option", { name: /TASK-07/ });
    await armed.click();

    // Cursor followed the arm: the armed row is now the active descendant.
    const armedEl = document.querySelector(".cb-row.armed")!;
    expect(armedEl.getAttribute("aria-selected")).toBe("true");
    expect(page.getByRole("combobox").element().getAttribute("aria-activedescendant")).toBe(
      armedEl.id,
    );

    // Confirm from the INPUT (not the row's own handler), so this exercises the cursor sync.
    await pastDwell();
    await page.getByRole("combobox").click();
    await userEvent.keyboard("{Enter}");
    expect(run).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  });

  it("a held key never fires — repeat keydowns are rejected on both the input and the row", async () => {
    // The 300ms dwell cannot stop this: the OS initial repeat delay (~500ms) clears it easily.
    // e.repeat is the only key-repeat defense, and after an arm-by-click the row (not the input)
    // is the focused element receiving the keys.
    const { commands, run } = seedDestructive();
    renderBar({ commands });
    await page.getByRole("combobox").fill("decom");

    const repeatKey = (el: Element, key: string) =>
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key, repeat: true, bubbles: true, cancelable: true }),
      );

    // Held Enter on the input: cannot even arm.
    repeatKey(page.getByRole("combobox").element(), "Enter");
    expect(document.querySelector(".cb-row.armed")).toBeNull();
    expect(run).not.toHaveBeenCalled();

    // Arm for real, then hold Enter / Space on the row itself: cannot confirm.
    await decomRow().click();
    await expect.element(decomRow()).toHaveTextContent(CONFIRM);
    await pastDwell();
    repeatKey(decomRow().element(), "Enter");
    repeatKey(decomRow().element(), " ");
    expect(run).not.toHaveBeenCalled();

    // A genuine (non-repeat) press still confirms.
    await decomRow().click();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("drops a confirm that lands inside the 300ms dwell (double-click guard)", async () => {
    const { commands, run } = seedDestructive();
    renderBar({ commands });
    await page.getByRole("combobox").fill("decom");

    await decomRow().click();
    await decomRow().click(); // immediate second click — inside the dwell
    expect(run).not.toHaveBeenCalled();
    // Still armed, so a deliberate confirm afterwards works.
    await expect.element(decomRow()).toHaveTextContent(CONFIRM);
    await pastDwell();
    await decomRow().click();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("disarms on typing and on moving the cursor", async () => {
    const { commands, run } = seedDestructive();
    renderBar({ commands });
    const input = page.getByRole("combobox");

    await input.fill("decom");
    await userEvent.keyboard("{Enter}");
    await expect.element(decomRow()).toHaveTextContent(CONFIRM);
    await input.fill("decomm"); // query change re-ranks the list → arm abandoned
    await expect.element(decomRow()).toHaveTextContent("Decommission TASK-07");
    await vi.waitFor(() => expect(srText()).toBe(""));

    await userEvent.keyboard("{Enter}");
    await expect.element(decomRow()).toHaveTextContent(CONFIRM);
    await userEvent.keyboard("{ArrowDown}"); // cursor move → arm abandoned
    await expect.element(decomRow()).toHaveTextContent("Decommission TASK-07");

    expect(run).not.toHaveBeenCalled();
  });
});

describe("CommandBar — armed row survives a live option-list change", () => {
  it("re-anchors the cursor when a WS session update shifts every row's oid", async () => {
    // `oid` is re-assigned on every re-derive of the groups, so a session arriving while a row is
    // armed shifts them all. Without re-anchoring, the red "Confirm decommission?" row would stay
    // armed while Enter fired whatever now sat at the stale activeIdx.
    const run = vi.fn();
    const { commands } = seedDestructive(run);
    const onselectsession = vi.fn();
    const { rerender } = await render(CommandBar, {
      sessions: [session({ id: "s1", name: "decom-one", updatedAt: 10 })],
      workingBlocked: {},
      commands,
      onselectsession,
      onselectrepo: vi.fn(),
      onfilterrepo: vi.fn(),
      onselectlens: vi.fn(),
      onclose: vi.fn(),
    });

    await page.getByRole("combobox").fill("decom");
    await decomRow().click();
    expect(document.querySelector(".cb-row.armed")!.getAttribute("aria-selected")).toBe("true");

    // A newer session lands (WS): it sorts ahead in the Sessions group and shifts the command
    // row's oid.
    await rerender({
      sessions: [
        session({ id: "s1", name: "decom-one", updatedAt: 10 }),
        session({ id: "s2", name: "decom-two", updatedAt: 99 }),
      ],
    });

    // Cursor followed the armed row rather than staying on the (now different) stale index.
    await vi.waitFor(() => {
      const armed = document.querySelector(".cb-row.armed")!;
      expect(armed.getAttribute("aria-selected")).toBe("true");
      expect(page.getByRole("combobox").element().getAttribute("aria-activedescendant")).toBe(
        armed.id,
      );
    });

    await pastDwell();
    await userEvent.keyboard("{Enter}");
    expect(run).toHaveBeenCalledTimes(1);
    expect(onselectsession).not.toHaveBeenCalled();
  });

  it("disarms when the armed command leaves the list entirely", async () => {
    const { commands, run } = seedDestructive();
    const { rerender } = await render(CommandBar, {
      sessions: [session({ id: "s1", name: "decom-one" })],
      workingBlocked: {},
      commands,
      onselectsession: vi.fn(),
      onselectrepo: vi.fn(),
      onfilterrepo: vi.fn(),
      onselectlens: vi.fn(),
      onclose: vi.fn(),
    });

    await page.getByRole("combobox").fill("decom");
    await decomRow().click();
    expect(document.querySelector(".cb-row.armed")).not.toBeNull();

    // The selected session went away server-side → the page stops offering the verb.
    await rerender({ commands: [] });
    await vi.waitFor(() => expect(srText()).toBe(""));

    // The verb comes back (a new session is selected). The arm must NOT have survived its absence:
    // a stale armedId (whose dwell has long since elapsed) would treat the very next activation as
    // the CONFIRM, decommissioning on a single click with no confirmation at all.
    await rerender({ commands });
    // waitFor, not a bare querySelector: the restored props flush asynchronously, and probing the
    // DOM before that lands would read the pre-rerender row and pass vacuously.
    await vi.waitFor(() => {
      expect(document.querySelectorAll(".cb-row")).toHaveLength(2);
      expect(document.querySelector(".cb-row.armed")).toBeNull();
    });

    await decomRow().click();
    await expect.element(decomRow()).toHaveTextContent(CONFIRM); // arms afresh, does not fire
    expect(run).not.toHaveBeenCalled();
  });
});
