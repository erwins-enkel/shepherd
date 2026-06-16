import { describe, expect, it } from "bun:test";
import { IncusDriver } from "../../ci/onboarding-harness/incus";
import { bootShepherd, probeDiagnostics } from "../../ci/onboarding-harness/probe";
import type { IncusExec } from "../../ci/onboarding-harness/types";

// Classify an exec by its command content (the last arg of `sh -c <cmd>`).
type ExecKind = "launch" | "poll" | "guard" | "tail" | "other";
function kindOf(args: string[]): ExecKind {
  const cmd = args[args.length - 1] ?? "";
  if (cmd.includes("src/index.ts")) return "launch";
  if (cmd.includes("seq 1")) return "poll";
  if (cmd.includes("[ $? -eq 7 ]") || cmd.includes("--max-time 2")) return "guard";
  if (cmd.includes("tail -n")) return "tail";
  return "other";
}

/** Content-dispatching mock: per ExecKind, either a fixed result or a throw.
 *  `poll` may take an array consumed in order (first call vs. retry). */
function dispatcher(spec: Partial<Record<ExecKind, IncusExec | IncusExec[] | "throw">>): {
  run: (args: string[]) => Promise<IncusExec>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const pollQueue = Array.isArray(spec.poll) ? [...spec.poll] : null;
  const run = async (args: string[]): Promise<IncusExec> => {
    calls.push(args);
    const k = kindOf(args);
    if (k === "poll" && pollQueue) {
      return pollQueue.shift() ?? { stdout: "", stderr: "", code: 0 };
    }
    const v = spec[k];
    if (v === "throw") throw new Error(`exec failed: ${k}`);
    if (Array.isArray(v)) return v[0] ?? { stdout: "", stderr: "", code: 0 };
    return v ?? { stdout: "", stderr: "", code: 0 };
  };
  return { run, calls };
}

const OK: IncusExec = { stdout: "", stderr: "", code: 0 };
const FAIL: IncusExec = { stdout: "", stderr: "", code: 1 };

describe("bootShepherd", () => {
  it("runs the entry file directly, detached, with installs visible on PATH", async () => {
    const calls: string[][] = [];
    const run = async (args: string[]): Promise<IncusExec> => {
      calls.push(args);
      return { stdout: "", stderr: "", code: 0 };
    };
    const d = new IncusDriver(run, "shep-onb-");
    await bootShepherd(d, "node-too-old");
    const boot = calls[0]!.join(" ");
    expect(boot).toContain("src/index.ts"); // not the nested `bun run start` script
    expect(boot).not.toContain("run start");
    expect(boot).toContain("setsid"); // survives the exec session
    expect(boot).toContain(".local/bin"); // remediation installs resolve on PATH
  });

  // (a) the poll ceiling was widened 60 → 120.
  it("polls on the widened 120s ceiling", async () => {
    const { run, calls } = dispatcher({ launch: OK, poll: OK });
    const d = new IncusDriver(run, "shep-onb-");
    await bootShepherd(d, "node-too-old");
    const poll = calls.find((c) => kindOf(c) === "poll")!.join(" ");
    expect(poll).toContain("seq 1 120");
    expect(poll).not.toContain("seq 1 60");
  });

  // (b) poll fails but the port is OCCUPIED ⇒ no relaunch; failure captures the log tail.
  it("does not relaunch when the port is occupied, and captures the boot-log tail", async () => {
    const SENTINEL = "FATAL: boot exploded here";
    const { run, calls } = dispatcher({
      launch: OK,
      poll: FAIL,
      guard: FAIL, // guard non-zero ⇒ port occupied ⇒ NO relaunch
      tail: { stdout: SENTINEL + "\n", stderr: "", code: 0 },
    });
    const d = new IncusDriver(run, "shep-onb-");
    await expect(bootShepherd(d, "herdr-missing")).rejects.toThrow(SENTINEL);
    // exactly one launch exec issued (no retry)
    expect(calls.filter((c) => kindOf(c) === "launch").length).toBe(1);
  });

  // (c) poll fails and the port is FREE (curl exit 7) ⇒ relaunch ONCE (append) + re-poll succeeds.
  it("relaunches once with append redirect when the port is free, then succeeds", async () => {
    const { run, calls } = dispatcher({
      launch: OK,
      poll: [FAIL, OK], // first poll fails, retry poll succeeds
      guard: OK, // guard 0 ⇒ port free ⇒ server died ⇒ relaunch
    });
    const d = new IncusDriver(run, "shep-onb-");
    await bootShepherd(d, "herdr-missing"); // no throw
    const launches = calls.filter((c) => kindOf(c) === "launch");
    expect(launches.length).toBe(2); // a second launch fired
    expect(launches[1]!.join(" ")).toContain(">>"); // relaunch appends, not truncates
    expect(launches[0]!.join(" ")).not.toContain(">>"); // first launch truncates
    expect(calls.filter((c) => kindOf(c) === "poll").length).toBe(2); // a second poll ran
  });

  // (d) capture must never mask: a throwing tail exec still yields the bare message.
  it("falls back to the bare failure message when the log tail throws", async () => {
    const { run } = dispatcher({ launch: OK, poll: FAIL, guard: FAIL, tail: "throw" });
    const d = new IncusDriver(run, "shep-onb-");
    await expect(bootShepherd(d, "herdr-missing")).rejects.toThrow(
      "Shepherd did not come up in herdr-missing",
    );
  });

  // (d-variant) an empty log body still keeps the bare failure text.
  it("keeps the bare failure message when the log is empty", async () => {
    const { run } = dispatcher({
      launch: OK,
      poll: FAIL,
      guard: FAIL,
      tail: { stdout: "   \n", stderr: "", code: 0 },
    });
    const d = new IncusDriver(run, "shep-onb-");
    await expect(bootShepherd(d, "arch-x")).rejects.toThrow("Shepherd did not come up in arch-x");
  });
});

describe("probeDiagnostics", () => {
  it("curls the diagnostics endpoint inside the instance and parses the snapshot", async () => {
    const snapshot = {
      checks: [{ id: "gh", state: "error", hintKey: "diagnostics_hint_gh_not_authenticated" }],
      generatedAt: 5,
      overall: "error",
    };
    const calls: string[][] = [];
    const run = async (args: string[]): Promise<IncusExec> => {
      calls.push(args);
      return { stdout: JSON.stringify(snapshot), stderr: "", code: 0 };
    };
    const d = new IncusDriver(run, "shep-onb-");
    const snap = await probeDiagnostics(d, "gh-unauthed");
    expect(snap.overall).toBe("error");
    expect(snap.checks[0]!.id).toBe("gh");
    // exec'd a curl against the loopback diagnostics endpoint with refresh
    const cmd = calls[0]!.join(" ");
    expect(cmd).toContain("curl");
    expect(cmd).toContain("/api/diagnostics?refresh=1");
  });
});
