import { describe, expect, it } from "vitest";
import {
  FACT_GLYPH,
  mergeActionLabel,
  mergeBlockedText,
  prActionRowVisible,
  prRowFacts,
  prRowLabel,
  prRowStatus,
  type PrRowKind,
} from "./pr-action-row";
import type { CriticChip } from "../critic-badge";
import type { GitState } from "#lib/types.js";

function git(over: Partial<GitState> = {}): GitState {
  return {
    kind: "github",
    state: "open",
    checks: "success",
    deployConfigured: false,
    number: 3540,
    mergeStateStatus: "clean",
    mergeable: true,
    ...over,
  };
}

const NONE: CriticChip = { kind: "none" };

describe("prActionRowVisible", () => {
  it("only an open PR shows the row", () => {
    expect(prActionRowVisible(git())).toBe(true);
    expect(prActionRowVisible(git({ state: "none" }))).toBe(false);
    expect(prActionRowVisible(git({ state: "merged" }))).toBe(false);
    expect(prActionRowVisible(git({ state: "closed" }))).toBe(false);
    expect(prActionRowVisible(null)).toBe(false);
    expect(prActionRowVisible(undefined)).toBe(false);
  });
});

describe("prRowStatus", () => {
  it("a clean green PR is ready", () => {
    expect(prRowStatus(git(), false)).toBe("ready");
  });

  it("a merge in flight wins over every block", () => {
    expect(prRowStatus(git({ checks: "failure", isDraft: true }), true)).toBe("merging");
  });

  it("readiness blocks come from the shared prReadinessBlock, in its order", () => {
    expect(prRowStatus(git({ isDraft: true, mergeStateStatus: "behind" }), false)).toBe("draft");
    expect(prRowStatus(git({ mergeStateStatus: "dirty", mergeable: false }), false)).toBe(
      "conflict",
    );
    expect(prRowStatus(git({ mergeStateStatus: "behind" }), false)).toBe("behind");
  });

  it("conflict and staleness outrank CI — fixing them reruns CI anyway", () => {
    expect(prRowStatus(git({ mergeStateStatus: "behind", checks: "pending" }), false)).toBe(
      "behind",
    );
    expect(prRowStatus(git({ mergeStateStatus: "dirty", checks: "failure" }), false)).toBe(
      "conflict",
    );
  });

  it("strict CI lock: a failing non-required check (unstable) still locks Merge", () => {
    expect(prRowStatus(git({ mergeStateStatus: "unstable", checks: "failure" }), false)).toBe(
      "ci_failed",
    );
  });

  it("strict CI lock: running checks lock Merge, also on hosts without a merge state", () => {
    expect(prRowStatus(git({ mergeStateStatus: "unstable", checks: "pending" }), false)).toBe(
      "ci_running",
    );
    expect(
      prRowStatus(git({ kind: "gitea", mergeStateStatus: undefined, checks: "pending" }), false),
    ).toBe("ci_running");
  });

  it("a required check still running reads as CI running, not as protection", () => {
    expect(prRowStatus(git({ mergeStateStatus: "blocked", checks: "pending" }), false)).toBe(
      "ci_running",
    );
    expect(prRowStatus(git({ mergeStateStatus: "blocked", checks: "success" }), false)).toBe(
      "protected",
    );
  });

  it("no CI at all (local forge, Gitea without CI) does not lock Merge", () => {
    expect(
      prRowStatus(git({ kind: "local", checks: "none", mergeStateStatus: undefined }), false),
    ).toBe("ready");
  });
});

describe("mergeBlockedText / prRowLabel", () => {
  const kinds: PrRowKind[] = [
    "merging",
    "draft",
    "conflict",
    "behind",
    "ci_failed",
    "ci_running",
    "protected",
  ];

  it("every locked kind names a reason; ready names none", () => {
    for (const k of kinds) expect(mergeBlockedText(k), k).toBeTruthy();
    expect(mergeBlockedText("ready")).toBeNull();
  });

  it("every kind has a label, and behind names the base", () => {
    for (const k of [...kinds, "ready" as const]) expect(prRowLabel(k, "main"), k).toBeTruthy();
    expect(prRowLabel("behind", "main")).toContain("main");
  });
});

describe("mergeActionLabel", () => {
  it("local wins over epic, epic over plain", () => {
    expect(mergeActionLabel(true, true)).toBe(mergeActionLabel(true, false));
    expect(mergeActionLabel(false, true)).not.toBe(mergeActionLabel(false, false));
  });
});

describe("prRowFacts", () => {
  const ids = (facts: ReturnType<typeof prRowFacts>) => facts.map((f) => f.id);
  const tones = (facts: ReturnType<typeof prRowFacts>) =>
    Object.fromEntries(facts.map((f) => [f.id, f.tone]));

  it("a measured clean PR with a reviewed verdict: all four facts green, in order", () => {
    const facts = prRowFacts({
      git: git(),
      chip: { kind: "verdict", decision: "commented", label: "✓" },
      criticOn: true,
      base: "main",
    });
    expect(ids(facts)).toEqual(["ci", "critic", "base", "conflicts"]);
    expect(facts.every((f) => f.tone === "ok")).toBe(true);
    expect(facts.find((f) => f.id === "base")?.text).toContain("main");
  });

  it("CI maps pending / failure / none", () => {
    expect(
      tones(
        prRowFacts({ git: git({ checks: "pending" }), chip: NONE, criticOn: false, base: "main" }),
      ).ci,
    ).toBe("pending");
    expect(
      tones(
        prRowFacts({ git: git({ checks: "failure" }), chip: NONE, criticOn: false, base: "main" }),
      ).ci,
    ).toBe("fail");
    expect(
      tones(prRowFacts({ git: git({ checks: "none" }), chip: NONE, criticOn: false, base: "main" }))
        .ci,
    ).toBe("pending");
  });

  it("the critic fact follows the chip, and is left out where no critic runs", () => {
    const at = (chip: CriticChip, criticOn = true) =>
      tones(prRowFacts({ git: git(), chip, criticOn, base: "main" })).critic;
    expect(at({ kind: "reviewing", hasFindings: false })).toBe("pending");
    expect(at({ kind: "verdict", decision: "changes_requested", label: "" })).toBe("fail");
    expect(at({ kind: "verdict", decision: "error", label: "" })).toBe("fail");
    expect(at(NONE)).toBe("pending");
    expect(at(NONE, false)).toBeUndefined();
  });

  it("behind is a failed base fact; an unmeasured merge state leaves base out", () => {
    const behind = prRowFacts({
      git: git({ mergeStateStatus: "behind" }),
      chip: NONE,
      criticOn: false,
      base: "dev",
    });
    expect(behind.find((f) => f.id === "base")).toMatchObject({ tone: "fail" });
    expect(behind.find((f) => f.id === "base")?.text).toContain("dev");
    for (const mergeStateStatus of ["unknown", "blocked", "draft", undefined] as const) {
      const facts = prRowFacts({
        git: git({ mergeStateStatus }),
        chip: NONE,
        criticOn: false,
        base: "main",
      });
      expect(ids(facts), String(mergeStateStatus)).not.toContain("base");
    }
  });

  it("conflicts: definite → fail, measured or mergeable → ok, unknown → left out", () => {
    const at = (over: Partial<GitState>) =>
      tones(prRowFacts({ git: git(over), chip: NONE, criticOn: false, base: "main" })).conflicts;
    expect(at({ mergeStateStatus: "dirty", mergeable: false })).toBe("fail");
    expect(at({ mergeStateStatus: undefined, mergeable: true })).toBe("ok");
    expect(at({ mergeStateStatus: "unknown", mergeable: null })).toBeUndefined();
  });

  it("every tone has a glyph", () => {
    expect(FACT_GLYPH).toEqual({ ok: "✓", pending: "◌", fail: "✗" });
  });
});
