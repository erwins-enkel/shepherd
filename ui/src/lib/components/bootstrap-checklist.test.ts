import { describe, expect, it } from "vitest";
import type { RepoBootstrapView } from "#lib/api.js";
import {
  checklistAction,
  checklistMustHaves,
  checklistStepKind,
  checklistSteps,
} from "./bootstrap-checklist";
import { pickedDocs } from "./new-project/project-docs";

const view = (phase: number, next: RepoBootstrapView["next"]): RepoBootstrapView => ({
  state: "active",
  phase,
  overrideAt: null,
  missing: [],
  suggested: false,
  next,
});

describe("checklistSteps (#3112)", () => {
  it("marks done/current/todo by phase; P1 and P2 share one row", () => {
    const states = (p: number) => checklistSteps(p).map((s) => s.state);
    expect(states(1)).toEqual(["current", "todo", "todo", "todo"]);
    expect(states(2)).toEqual(["current", "todo", "todo", "todo"]);
    expect(states(3)).toEqual(["done", "current", "todo", "todo"]);
    expect(states(4)).toEqual(["done", "done", "current", "todo"]);
    expect(states(5)).toEqual(["done", "done", "done", "current"]);
  });

  it("a held CI advance (#3411) marks the current row held", () => {
    const held = (p: number) => checklistSteps(p, true).map((s) => s.state);
    expect(held(1)).toEqual(["held", "todo", "todo", "todo"]);
    expect(held(3)).toEqual(["done", "held", "todo", "todo"]);
  });
});

describe("checklistMustHaves", () => {
  it("keeps the red must-haves and the pending placeholder, drops the phases", () => {
    const missing = ["P4", "forge_settings", "readiness_pending"];
    expect(checklistMustHaves({ ...view(4, null), missing })).toEqual([
      "forge_settings",
      "readiness_pending",
    ]);
  });
});

describe("checklistAction (#3112)", () => {
  it("maps the server's next step to one action", () => {
    expect(checklistAction(view(1, { kind: "bootstrap", phase: 1, sessionId: null }))).toEqual({
      kind: "start-bootstrap",
      phase: 1,
    });
    expect(checklistAction(view(4, { kind: "epic", phase: 4, sessionId: null }))).toEqual({
      kind: "start-epic",
    });
    expect(checklistAction(view(5, { kind: "readiness", phase: 5, sessionId: null }))).toEqual({
      kind: "open-readiness",
    });
  });

  it("a running session wins; off/done or no next → nothing", () => {
    expect(checklistAction(view(3, { kind: "bootstrap", phase: 3, sessionId: "s1" }))).toEqual({
      kind: "open-session",
      sessionId: "s1",
    });
    expect(checklistAction({ ...view(5, null), state: "done" })).toBeNull();
    expect(checklistAction(view(1, undefined))).toBeNull();
  });

  it("a held CI advance (#3411) wins, even over the merged session still running", () => {
    const live = view(1, { kind: "bootstrap", phase: 1, sessionId: "s1" });
    expect(checklistAction({ ...live, ciHold: "waiting" })).toEqual({ kind: "ci-waiting" });
    expect(checklistAction({ ...live, ciHold: "failed" })).toEqual({ kind: "fix-ci" });
    expect(checklistAction({ ...live, ciHold: null })).toEqual({
      kind: "open-session",
      sessionId: "s1",
    });
  });
});

describe("checklistStepKind (#3421)", () => {
  it("names the composer step a start action opens; open/wait actions have none", () => {
    expect(checklistStepKind({ kind: "start-bootstrap", phase: 1 })).toBe("scaffold");
    expect(checklistStepKind({ kind: "start-bootstrap", phase: 2 })).toBe("scaffold");
    expect(checklistStepKind({ kind: "start-bootstrap", phase: 3 })).toBe("gaps");
    expect(checklistStepKind({ kind: "start-epic" })).toBe("epic");
    expect(checklistStepKind({ kind: "fix-ci" })).toBe("fix-ci");
    expect(checklistStepKind({ kind: "open-session", sessionId: "s1" })).toBeNull();
    expect(checklistStepKind({ kind: "open-readiness" })).toBeNull();
    expect(checklistStepKind({ kind: "ci-waiting" })).toBeNull();
  });
});

describe("pickedDocs (#3112)", () => {
  const picked = (name: string, rel = "") => {
    const f = new File(["x"], name);
    if (rel) Object.defineProperty(f, "webkitRelativePath", { value: rel });
    return f;
  };

  it("keeps a file pick's name and drops a folder pick's top folder", () => {
    expect(pickedDocs([picked("prd.md")]).map((d) => d.path)).toEqual(["prd.md"]);
    expect(pickedDocs([picked("a.png", "export/screens/a.png")]).map((d) => d.path)).toEqual([
      "screens/a.png",
    ]);
  });

  it("skips hidden files", () => {
    expect(pickedDocs([picked(".DS_Store", "export/.DS_Store")])).toEqual([]);
    expect(pickedDocs([picked("config", "export/.git/config")])).toEqual([]);
    expect(pickedDocs([picked("a.md"), picked(".x")]).map((d) => d.path)).toEqual(["a.md"]);
  });
});
