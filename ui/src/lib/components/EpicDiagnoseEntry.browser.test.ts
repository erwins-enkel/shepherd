import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../app.css";
import EpicDiagnoseEntry from "./EpicDiagnoseEntry.svelte";
import { m } from "$lib/paraglide/messages";
import type { EpicDiagnosis, RepoEntry } from "$lib/types";

// EpicDiagnoseEntry calls listRepos() on mount; the child EpicDiagnosisModal calls
// diagnoseEpic() on mount. Stub both so the flow runs without a server. Everything else
// (glossary, etc.) stays real.
const listRepos = vi.fn<() => Promise<{ repos: RepoEntry[]; recentWindowDays: number }>>();
const diagnoseEpic = vi.fn<(repo: string, parent: number) => Promise<EpicDiagnosis>>();

vi.mock("$lib/api", async (orig) => ({
  ...((await orig()) as object),
  listRepos: (...a: unknown[]) => listRepos(...(a as [])),
  diagnoseEpic: (...a: unknown[]) => diagnoseEpic(...(a as [string, number])),
}));

function repo(name: string): RepoEntry {
  return {
    name,
    path: `/repos/${name}`,
    realPath: `/repos/${name}`,
    display: `/repos/${name}`,
    lastUsedAt: 1,
    hidden: false,
  } as RepoEntry;
}

const unrecognized: EpicDiagnosis = {
  parentIssueNumber: 412,
  recognized: false,
  source: null,
  findings: [{ id: "no-children", severity: "error" }],
  additionalWarnings: [],
};

beforeEach(() => {
  listRepos.mockReset().mockResolvedValue({ repos: [repo("alpha")], recentWindowDays: 30 });
  diagnoseEpic.mockReset().mockResolvedValue(unrecognized);
});

describe("EpicDiagnoseEntry", () => {
  it("gates Diagnose until a positive-integer issue number is entered", async () => {
    render(EpicDiagnoseEntry, { onclose: vi.fn() });

    const submit = page.getByRole("button", { name: m.epic_diag_entry_submit() });
    // Repo defaults from listRepos, but with no number the submit stays disabled.
    await expect.element(submit).toBeDisabled();

    await userEvent.fill(page.getByPlaceholder(m.epic_diag_entry_issue_placeholder()), "0");
    await expect.element(submit).toBeDisabled(); // 0 is not a valid issue number

    await userEvent.fill(page.getByPlaceholder(m.epic_diag_entry_issue_placeholder()), "412");
    await expect.element(submit).toBeEnabled();
  });

  it("submitting runs the diagnosis for the typed parent and shows the unrecognized result", async () => {
    render(EpicDiagnoseEntry, { initialRepo: "/repos/alpha", onclose: vi.fn() });

    await userEvent.fill(page.getByPlaceholder(m.epic_diag_entry_issue_placeholder()), "412");
    await userEvent.click(page.getByRole("button", { name: m.epic_diag_entry_submit() }));

    // The unchanged EpicDiagnosisModal renders the no-children / not-recognized finding.
    await expect.element(page.getByText(m.epic_diag_source_none())).toBeInTheDocument();
    await expect.element(page.getByText(m.epic_diag_no_children_title())).toBeInTheDocument();
    expect(diagnoseEpic).toHaveBeenCalledWith("/repos/alpha", 412);
  });
});
