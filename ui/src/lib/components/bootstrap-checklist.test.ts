import { describe, expect, it } from "vitest";
import type { RepoBootstrapView } from "#lib/api.js";
import { checklistAction, checklistSteps } from "./bootstrap-checklist";
import { docPath, toDocs } from "./new-project/project-docs";

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
});

describe("docPath (#3112)", () => {
  const picked = (name: string, rel = "") => {
    const f = new File(["x"], name);
    if (rel) Object.defineProperty(f, "webkitRelativePath", { value: rel });
    return f;
  };

  it("keeps a file pick's name and drops a folder pick's top folder", () => {
    expect(docPath(picked("prd.md"))).toBe("prd.md");
    expect(docPath(picked("a.png", "export/screens/a.png"))).toBe("screens/a.png");
  });

  it("skips hidden files", () => {
    expect(docPath(picked(".DS_Store", "export/.DS_Store"))).toBeNull();
    expect(docPath(picked("config", "export/.git/config"))).toBeNull();
    expect(toDocs([picked("a.md"), picked(".x")]).map((d) => d.path)).toEqual(["a.md"]);
  });
});
