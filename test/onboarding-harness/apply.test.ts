import { describe, expect, it } from "bun:test";
import {
  resolveCoaching,
  buildAgentPrompt,
  applyVerbatim,
} from "../../ci/onboarding-harness/apply";
import { IncusDriver } from "../../ci/onboarding-harness/incus";
import type { DiagnosticsSnapshot } from "../../src/types";

const snap: DiagnosticsSnapshot = {
  checks: [
    { id: "gh", state: "error", hintKey: "diagnostics_hint_gh_not_authenticated" },
    { id: "git", state: "ok", hintKey: "diagnostics_hint_git_ok" },
  ],
  generatedAt: 1,
  overall: "error",
};

describe("resolveCoaching", () => {
  it("resolves non-ok check hintKeys to their EN message text", () => {
    const messages = {
      diagnostics_hint_gh_not_authenticated: "Run `gh auth login` to authenticate.",
    };
    const lines = resolveCoaching(snap, messages);
    expect(lines).toEqual([{ id: "gh", text: "Run `gh auth login` to authenticate." }]);
  });

  it("skips ok checks and falls back to the raw key when a message is missing", () => {
    const lines = resolveCoaching(snap, {});
    expect(lines).toEqual([{ id: "gh", text: "diagnostics_hint_gh_not_authenticated" }]);
  });
});

describe("buildAgentPrompt", () => {
  it("includes the coaching text and a clear success instruction", () => {
    const p = buildAgentPrompt([{ id: "gh", text: "Run gh auth login." }]);
    expect(p).toContain("Run gh auth login.");
    expect(p.toLowerCase()).toContain("healthy");
  });
});

describe("applyVerbatim", () => {
  it("runs each harness-catalog remediation for non-ok checks inside the instance", async () => {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      return { stdout: "", stderr: "", code: 0 };
    };
    const d = new IncusDriver(run, "shep-onb-");
    const snap = {
      checks: [{ id: "bun", state: "error" as const, hintKey: "diagnostics_hint_bun_missing" }],
      generatedAt: 1,
      overall: "error" as const,
    };
    const ok = await applyVerbatim(d, "bun-missing", snap);
    expect(ok).toBe(true);
    expect(calls[0]!.join(" ")).toContain("bun.sh/install");
  });

  it("treats a failing optional remediation as non-fatal and still runs later required ones", async () => {
    // Mirrors node-too-old: codex is `optional` (claude present) and its install fails,
    // but it sorts before node — the node fix must still run and the apply must succeed.
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      const joined = args.join(" ");
      const code = joined.includes("chatgpt.com/codex") ? 1 : 0; // codex installer broken
      return { stdout: "", stderr: "", code };
    };
    const d = new IncusDriver(run, "shep-onb-");
    const snap = {
      checks: [
        { id: "codex", state: "optional" as const, hintKey: "diagnostics_hint_codex_optional" },
        { id: "node", state: "warning" as const, hintKey: "diagnostics_hint_node_outdated" },
      ],
      generatedAt: 1,
      overall: "warning" as const,
    };
    const ok = await applyVerbatim(d, "node-too-old", snap, { attempts: 2, delayMs: 0 });
    expect(ok).toBe(true);
    const codexCalls = calls.filter((c) => c.join(" ").includes("chatgpt.com/codex"));
    expect(codexCalls.length).toBe(1); // attempted once, NOT retried (optional ⇒ non-fatal)
    expect(calls.some((c) => c.join(" ").includes("fnm.vercel.app"))).toBe(true); // node still ran
  });

  it("still fails the apply when a required (non-optional) remediation fails", async () => {
    const run = async (args: string[]) => ({
      stdout: "",
      stderr: "",
      code: args.join(" ").includes("bun.sh/install") ? 1 : 0,
    });
    const d = new IncusDriver(run, "shep-onb-");
    const snap = {
      checks: [{ id: "bun", state: "error" as const, hintKey: "diagnostics_hint_bun_missing" }],
      generatedAt: 1,
      overall: "error" as const,
    };
    const ok = await applyVerbatim(d, "bun-missing", snap, { delayMs: 0 });
    expect(ok).toBe(false);
  });

  it("retries a transient failure and succeeds within the bounded attempts", async () => {
    let bunCalls = 0;
    const run = async (args: string[]) => {
      if (args.join(" ").includes("bun.sh/install")) {
        bunCalls += 1;
        return { stdout: "", stderr: "", code: bunCalls === 1 ? 1 : 0 }; // flake once, then ok
      }
      return { stdout: "", stderr: "", code: 0 };
    };
    const d = new IncusDriver(run, "shep-onb-");
    const snap = {
      checks: [{ id: "bun", state: "error" as const, hintKey: "diagnostics_hint_bun_missing" }],
      generatedAt: 1,
      overall: "error" as const,
    };
    const ok = await applyVerbatim(d, "bun-missing", snap, { attempts: 2, delayMs: 0 });
    expect(ok).toBe(true);
    expect(bunCalls).toBe(2);
  });
});
