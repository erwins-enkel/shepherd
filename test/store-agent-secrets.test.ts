// Store side of per-repo agent secrets (#4122): the names-only injection audit, and redaction of
// registered secret values from agent-authored recap + plan revision text before it is persisted.
import { afterEach, expect, test } from "bun:test";
import { SessionStore } from "../src/store";
import { setKnownSecretValues } from "../src/redact";
import type { Recap } from "../src/types";

const SECRET = "ghp-not-a-real-token-but-long-4122";

afterEach(() => setKnownSecretValues([]));

test("recordAgentSecretInjection → agentSecretLastInjected keeps the latest time per name, per repo", () => {
  const s = new SessionStore(":memory:");
  expect(s.agentSecretLastInjected("/r/a")).toEqual({});
  s.recordAgentSecretInjection("s1", "/r/a", ["NPM_TOKEN", "PKG_TOKEN"], 100);
  s.recordAgentSecretInjection("s2", "/r/a", ["NPM_TOKEN"], 200);
  s.recordAgentSecretInjection("s3", "/r/b", ["NPM_TOKEN"], 300);
  s.recordAgentSecretInjection("s4", "/r/a", [], 400); // no-op
  expect(s.agentSecretLastInjected("/r/a")).toEqual({ NPM_TOKEN: 200, PKG_TOKEN: 100 });
  expect(s.agentSecretLastInjected("/r/b")).toEqual({ NPM_TOKEN: 300 });
  s.recordAgentSecretInjection("s5", "/r/c", ["__proto__"], 500);
  const odd = s.agentSecretLastInjected("/r/c");
  expect(Object.keys(odd)).toEqual(["__proto__"]); // an own entry, not a prototype write
  expect(Object.getPrototypeOf(odd)).toBe(Object.prototype);
});

test("putRecap redacts registered secret values from headline, body, open items and blocks", () => {
  setKnownSecretValues([SECRET]);
  const s = new SessionStore(":memory:");
  const recap: Recap = {
    sessionId: "s1",
    state: "ready",
    headSha: "abc",
    base: "main",
    verdict: null,
    headline: `used ${SECRET}`,
    body: `token=${SECRET} twice ${SECRET}`,
    openItems: [`rotate ${SECRET}`],
    changedFiles: ["src/a.ts"],
    spawnSessionId: "",
    cwd: "",
    model: null,
    spawnedAt: 1,
    generatedAt: 2,
    updatedAt: 2,
    blocks: [{ type: "callout", tone: "info", text: `see ${SECRET}` } as never],
  };
  s.putRecap(recap);
  const got = s.getRecap("s1")!;
  expect(JSON.stringify(got)).not.toContain(SECRET);
  expect(got.headline).toBe("used <redacted>");
  expect(got.body).toBe("token=<redacted> twice <redacted>");
  expect(got.openItems).toEqual(["rotate <redacted>"]);
  expect(got.changedFiles).toEqual(["src/a.ts"]);
});

test("plan revisions redact registered secret values from the plan text and edits", () => {
  setKnownSecretValues([SECRET]);
  const s = new SessionStore(":memory:");
  s.recordAgentPlanRevision("s1", "h1", `PLAN with ${SECRET}`);
  s.recordOperatorPlanRevision(
    "s1",
    { planHash: "h1", plan: `PLAN with ${SECRET}` },
    { planHash: "h2", plan: `PLAN 2 ${SECRET}` },
    [{ id: "e1", kind: "replace", section: "", before: SECRET, after: "x", reason: SECRET }],
  );
  const revs = s.listPlanRevisions("s1");
  expect(revs.map((r) => r.plan)).toEqual(["PLAN with <redacted>", "PLAN 2 <redacted>"]);
  expect(revs.map((r) => r.planHash)).toEqual(["h1", "h2"]);
  expect(JSON.stringify(revs)).not.toContain(SECRET);
  expect(revs[1]!.edits[0]).toMatchObject({ before: "<redacted>", reason: "<redacted>" });
});
