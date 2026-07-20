import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import PrRow from "./PrRow.svelte";
import type { PullRequest, PrKind } from "$lib/types";
import { m } from "$lib/paraglide/messages";

function pr(partial: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 1,
    title: "Some PR",
    url: "https://example.com/pr/1",
    author: "alice",
    kind: "regular",
    createdAt: Date.now(),
    isDraft: false,
    mergeable: true,
    checks: "none",
    jobs: [],
    ...partial,
  };
}

function renderRow(kind: PrKind) {
  render(PrRow, {
    repoPath: "/repo/a",
    pr: pr({ kind }),
    onreview: () => {},
    onmerged: () => {},
  });
}

describe("PrRow kind tag", () => {
  it("tags a dependabot PR", async () => {
    renderRow("dependabot");
    await expect.element(page.getByText(m.prkind_dependabot_tag())).toBeInTheDocument();
    expect(document.body.querySelector(".kind-tag.dep")).not.toBeNull();
  });

  it("tags a release PR", async () => {
    renderRow("release");
    await expect.element(page.getByText(m.prkind_release_tag())).toBeInTheDocument();
    expect(document.body.querySelector(".kind-tag.rel")).not.toBeNull();
  });

  it("a regular PR shows no kind tag", () => {
    renderRow("regular");
    expect(document.body.querySelector(".kind-tag")).toBeNull();
  });
});

describe("PrRow target branch chip", () => {
  it("renders the target-branch chip when nonDefaultBase is set", async () => {
    render(PrRow, {
      repoPath: "/repo/a",
      pr: pr({ nonDefaultBase: "epic/foo" }),
      onreview: () => {},
      onmerged: () => {},
    });
    const chip = document.body.querySelector(".target-branch");
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain("epic/foo");
  });

  it("renders no target-branch chip when nonDefaultBase is unset", () => {
    render(PrRow, {
      repoPath: "/repo/a",
      pr: pr(),
      onreview: () => {},
      onmerged: () => {},
    });
    expect(document.body.querySelector(".target-branch")).toBeNull();
  });
});

describe("PrRow awaiting-approval chip", () => {
  it("renders the needs-approval chip when awaitingWorkflowApproval is set", async () => {
    render(PrRow, {
      repoPath: "/repo/a",
      pr: pr({ awaitingWorkflowApproval: true }),
      onreview: () => {},
      onmerged: () => {},
    });
    await expect.element(page.getByText(m.prrow_awaiting_approval())).toBeInTheDocument();
    expect(document.body.querySelector(".needs-approval")).not.toBeNull();
  });

  it("renders no needs-approval chip when the flag is unset", () => {
    render(PrRow, {
      repoPath: "/repo/a",
      pr: pr(),
      onreview: () => {},
      onmerged: () => {},
    });
    expect(document.body.querySelector(".needs-approval")).toBeNull();
  });
});

describe("conflict chip — mirrors isConflicting", () => {
  it("shows for mergeable:false on a non-draft", async () => {
    render(PrRow, { props: { pr: pr({ mergeable: false }), repoPath: "/r" } as any });
    await expect.element(page.getByText(m.prspanel_conflicts())).toBeVisible();
  });

  it("shows for mergeStateStatus 'dirty' even while mergeable is still null", async () => {
    // GitHub computes mergeability lazily; dirty is the earlier, definite signal.
    render(PrRow, {
      props: { pr: pr({ mergeable: null, mergeStateStatus: "dirty" }), repoPath: "/r" } as any,
    });
    await expect.element(page.getByText(m.prspanel_conflicts())).toBeVisible();
  });

  it("shows for a DIRTY draft — DRAFT masks BEHIND, not DIRTY", async () => {
    render(PrRow, {
      props: {
        pr: pr({ isDraft: true, mergeable: null, mergeStateStatus: "dirty" }),
        repoPath: "/r",
      } as any,
    });
    await expect.element(page.getByText(m.prspanel_conflicts())).toBeVisible();
  });

  it("does NOT show for a Gitea-style draft (mergeable:false, no mergeStateStatus)", async () => {
    // Gitea reports mergeable:false for every WIP-prefixed draft — chipping those is a bug.
    render(PrRow, {
      props: { pr: pr({ isDraft: true, mergeable: false }), repoPath: "/r" } as any,
    });
    await expect.element(page.getByText(m.prspanel_conflicts())).not.toBeInTheDocument();
  });

  it("does NOT show for a clean PR", async () => {
    render(PrRow, { props: { pr: pr({ mergeable: true }), repoPath: "/r" } as any });
    await expect.element(page.getByText(m.prspanel_conflicts())).not.toBeInTheDocument();
  });
});
