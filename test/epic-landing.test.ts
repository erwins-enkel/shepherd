import { describe, expect, it } from "bun:test";
import { buildLandingPrBody, buildLandingPrTitle } from "../src/epic-landing";

describe("buildLandingPrTitle", () => {
  it("renders `Land epic #<n>: <title>`", () => {
    expect(buildLandingPrTitle(327, "EFI value map")).toBe("Land epic #327: EFI value map");
  });
});

describe("buildLandingPrBody", () => {
  const base = {
    parentNumber: 327,
    parentTitle: "EFI value map",
    integrationBranch: "epic/327-efi-value-map",
    defaultBranch: "main",
  };

  it("closes the parent and every child, one line each", () => {
    const children = [
      { number: 401, title: "A", prNumber: 410, prUrl: null },
      { number: 402, title: "B", prNumber: 420, prUrl: null },
      { number: 403, title: "C", prNumber: null, prUrl: null },
    ];
    const body = buildLandingPrBody({ ...base, children });
    expect(body).toContain("Closes #327");
    for (const c of children) {
      expect(body).toContain(`Closes #${c.number}`);
    }
    const closesLines = body.split("\n").filter((l) => /^Closes #\d+$/.test(l));
    expect(closesLines.length).toBe(children.length + 1);
  });

  it("`### Children (N)` header N equals children.length", () => {
    const children = [
      { number: 1, title: "x", prNumber: 11, prUrl: null },
      { number: 2, title: "y", prNumber: 12, prUrl: null },
      { number: 3, title: "z", prNumber: 13, prUrl: null },
    ];
    const body = buildLandingPrBody({ ...base, children });
    expect(body).toContain("### Children (3)");
  });

  it("renders #<prNumber> when present and — when null", () => {
    const children = [
      { number: 50, title: "has pr", prNumber: 330, prUrl: null },
      { number: 51, title: "no pr", prNumber: null, prUrl: null },
    ];
    const body = buildLandingPrBody({ ...base, children });
    const rows = body.split("\n").filter((l) => l.startsWith("| #"));
    const withPr = rows.find((r) => r.includes("#50"))!;
    const noPr = rows.find((r) => r.includes("#51"))!;
    expect(withPr).toContain("#330");
    expect(noPr).toContain("—");
  });

  it("escapes a pipe in a child title so the row stays 3 cells", () => {
    const children = [{ number: 70, title: "a | b", prNumber: 700, prUrl: null }];
    const body = buildLandingPrBody({ ...base, children });
    const row = body.split("\n").find((l) => l.startsWith("| #70"))!;
    // Escaped pipe present; no bare table-breaking pipe from the title.
    expect(row).toContain("a \\| b");
    // A `| a | b | c |` row has 4 unescaped delimiters → 5 split segments (empty, 3 cells,
    // empty). The escaped `\|` from the title must NOT add a delimiter, so it stays 5.
    const segments = row.split(/(?<!\\)\|/);
    expect(segments.length).toBe(5);
    const cells = segments.slice(1, -1).map((s) => s.trim());
    expect(cells).toEqual(["#70", "a \\| b", "#700"]);
  });

  it("collapses newlines in a child title to keep the row single-line", () => {
    const children = [{ number: 80, title: "line1\nline2", prNumber: 800, prUrl: null }];
    const body = buildLandingPrBody({ ...base, children });
    const row = body.split("\n").find((l) => l.startsWith("| #80"))!;
    expect(row).toContain("line1 line2");
  });

  it("empty children: header shows (0), only the parent Closes line, table header but no rows", () => {
    const body = buildLandingPrBody({ ...base, children: [] });
    expect(body).toContain("### Children (0)");
    const closesLines = body.split("\n").filter((l) => /^Closes #\d+$/.test(l));
    expect(closesLines).toEqual(["Closes #327"]);
    const rows = body.split("\n").filter((l) => l.startsWith("| #"));
    expect(rows.length).toBe(0);
    expect(body).toContain("| Issue | Title | PR |");
  });
});
