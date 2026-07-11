#!/usr/bin/env bun
/**
 * Live re-verification of herdr's `terminal session control` NDJSON contract.
 *
 * Runs against a LIVE herdr: creates a throwaway scratch pane, round-trips
 * terminal.input / terminal.resize / terminal.release, and asserts the framing
 * still matches what `src/socket-pty-bridge.ts` depends on (see
 * test/fixtures/terminal-control/capture-notes.md). Exits non-zero on drift.
 *
 * This is the herdr-upgrade check — it is intentionally NOT part of `bun test`
 * (it needs a live herdr daemon + a scratch pane). Run it after bumping herdr:
 *   bun scripts/verify-herdr-terminal.ts
 */
const herdrBin = process.env.HERDR_BIN || "herdr";
const SCRATCH_LABEL = "__verify_herdr_terminal__";

interface FrameRec {
  type: "terminal.frame";
  bytes: string;
  encoding: string;
  full: boolean;
  width: number;
  height: number;
  seq: number;
}
interface ClosedRec {
  type: "terminal.closed";
  reason: string;
}
type Rec = FrameRec | ClosedRec | { type: string };

interface TabCreateResult {
  result: { tab: { tab_id: string }; root_pane: { pane_id: string; workspace_id: string } };
}

function cli<T>(args: string[]): T {
  const p = Bun.spawnSync([herdrBin, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = p.stdout.toString().trim();
  if (!out) throw new Error(`herdr ${args.join(" ")} produced no output: ${p.stderr.toString()}`);
  return JSON.parse(out) as T;
}

const problems: string[] = [];
const check = (cond: boolean, msg: string) => {
  if (!cond) problems.push(msg);
};

// herdr frames are screen diffs: cursor-positioning escapes interleave the echoed
// characters, so strip escapes/control bytes before matching typed text.
const stripAnsi = (s: string): string =>
  s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

/** Stream `terminal session control <target>`, run a choreography, return the parsed records. */
async function controlRoundTrip(
  target: string,
): Promise<{ frames: FrameRec[]; closed: ClosedRec | null; exit: number }> {
  const proc = Bun.spawn(
    [
      herdrBin,
      "terminal",
      "session",
      "control",
      target,
      "--takeover",
      "--cols",
      "80",
      "--rows",
      "24",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const frames: FrameRec[] = [];
  let closed: ClosedRec | null = null;
  let sawFrame = false;

  const reader = (async () => {
    let buf = "";
    const dec = new TextDecoder();
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const rec = JSON.parse(line) as Rec;
        if (rec.type === "terminal.frame") {
          frames.push(rec as FrameRec);
          sawFrame = true;
        } else if (rec.type === "terminal.closed") {
          closed = rec as ClosedRec;
        }
      }
    }
  })();

  const send = (obj: unknown) => {
    proc.stdin.write(JSON.stringify(obj) + "\n");
    proc.stdin.flush();
  };
  for (let i = 0; i < 100 && !sawFrame; i++) await Bun.sleep(30);
  send({ type: "terminal.input", text: "echo VERIFY_OK\r" });
  await Bun.sleep(400);
  send({ type: "terminal.resize", cols: 100, rows: 30 });
  await Bun.sleep(400);
  send({ type: "terminal.release" });
  await Bun.sleep(400);
  proc.kill();
  const exit = await proc.exited;
  await Promise.race([reader, Bun.sleep(300)]);
  return { frames, closed, exit };
}

let scratchTabId: string | null = null;
try {
  // 1. Create a throwaway scratch pane.
  const created = cli<TabCreateResult>([
    "tab",
    "create",
    "--cwd",
    "/tmp",
    "--label",
    SCRATCH_LABEL,
    "--no-focus",
  ]);
  scratchTabId = created.result.tab.tab_id;
  const paneId = created.result.root_pane.pane_id;
  const workspaceId = created.result.root_pane.workspace_id;
  const target = paneId.includes(":") ? paneId : `${workspaceId}:${paneId}`;

  // 2. Happy-path round-trip.
  const { frames, closed, exit } = await controlRoundTrip(target);
  check(frames.length > 0, "no terminal.frame records received");
  const f0 = frames[0];
  if (f0) {
    for (const key of ["bytes", "encoding", "full", "width", "height", "seq"] as const) {
      check(key in f0, `terminal.frame missing field '${key}'`);
    }
    check(f0.full === true && f0.seq === 1, "first frame is not full:true seq:1");
    check(
      typeof f0.bytes === "string" && Buffer.from(f0.bytes, "base64").length > 0,
      "frame bytes not decodable base64",
    );
  }
  const echoed = frames.some((f) =>
    stripAnsi(Buffer.from(f.bytes, "base64").toString("utf8")).includes("VERIFY_OK"),
  );
  check(echoed, "terminal.input did not reach the PTY (echo not observed)");
  const resized = frames.some((f) => f.full === true && f.width === 100 && f.height === 30);
  check(resized, "terminal.resize did not produce a 100x30 full redraw");
  check(
    (closed as ClosedRec | null)?.type === "terminal.closed",
    "no terminal.closed after release",
  );
  check(exit === 0, `clean release exited ${exit}, expected 0`);

  // 3. Gone-target failure mode: exit 0 + terminal.closed{not found}, no frames.
  const bad = await controlRoundTrip(`${workspaceId}:pZZZZ`);
  check(bad.frames.length === 0, "bad target unexpectedly produced frames");
  check(
    /not found/i.test(bad.closed?.reason ?? ""),
    `bad target reason not 'not found': ${JSON.stringify(bad.closed)}`,
  );
} catch (err) {
  problems.push(`threw: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  if (scratchTabId) {
    try {
      cli(["tab", "close", scratchTabId]);
    } catch {
      /* best-effort cleanup */
    }
  }
}

if (problems.length) {
  console.error("herdr terminal contract DRIFT:\n  - " + problems.join("\n  - "));
  process.exit(1);
}
console.log(
  "herdr terminal session control contract OK (frame/input/resize/release/closed + gone-target).",
);
