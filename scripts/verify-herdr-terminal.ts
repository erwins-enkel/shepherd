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
 *
 * `--scroll` (or SHEPHERD_VERIFY_SCROLL=1) runs a second, heavier, opt-in mode: the app-binding
 * scroll matrix (issue #1639). It spins up throwaway `claude` + `codex` agents, fills each with a
 * tall transcript, and records which keyboard levers scroll it over `terminal.input`. REPORT-ONLY —
 * prints a per-agent matrix and exits 0 (a NOTICE flags divergence from the recorded baseline in
 * test/fixtures/terminal-control/scroll-binding-notes.md). It needs live agent auth + spends model
 * tokens, so it is opt-in and never wired into CI. Background: socket-mode scroll needs the *app* to
 * repaint on a lever (no scrollback in the frame stream); Claude honors PageUp, Codex honors none —
 * which is why SHEPHERD_HERDR_SOCKET_TERMINAL stays default-off. Re-run after a herdr/agent upgrade
 * to see whether that changed:
 *   bun scripts/verify-herdr-terminal.ts --scroll
 */
export {}; // make this a module so top-level await is allowed under tsc

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

/** Default mode: the herdr `terminal session control` wire-contract drift check. */
async function runDriftCheck(): Promise<void> {
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
}

// ── App-binding scroll matrix (opt-in: --scroll / SHEPHERD_VERIFY_SCROLL=1) ─────────────────────
// Issue #1639 Phase-0 gate. Drives a LIVE throwaway agent TUI and records which keyboard levers
// scroll its transcript over `terminal session control` (terminal.input) — the same channel the
// socket bridge would use. REPORT-ONLY: prints a per-agent lever matrix and exits 0; a NOTICE flags
// divergence from the recorded baseline. NOT a CI gate (needs live herdr + agent auth + tokens).

interface Lever {
  name: string;
  seq: string;
  repeat: number;
}
// "Up" levers (reveal older transcript). Ctrl+End (below) is the recovery, not a probe.
const UP_LEVERS: Lever[] = [
  { name: "PageUp", seq: "\x1b[5~", repeat: 4 },
  { name: "Shift+PageUp", seq: "\x1b[5;2~", repeat: 4 },
  { name: "Ctrl+Home", seq: "\x1b[1;5H", repeat: 1 },
  { name: "MouseWheelUp", seq: "\x1b[<64;40;12M", repeat: 6 },
];
const CTRL_END = "\x1b[1;5F"; // jump-to-bottom recovery (Claude honors it; no-op for non-scrollers)

// Agents we can start here. Codex needs the effort/verbosity overrides or its local default config
// trips a provider 400 (`text.verbosity='low'` unsupported for gpt-5.2-codex) → no transcript.
const SCROLL_AGENTS: { provider: string; argv: string[] }[] = [
  { provider: "claude", argv: ["claude"] },
  {
    provider: "codex",
    argv: ["codex", "-c", 'model_reasoning_effort="medium"', "-c", 'model_verbosity="medium"'],
  },
];
const GEN_PROMPT =
  "Output the integers 1 through 150, each on its own line. Output ONLY the numbers, one per line — no prose, no code block, no tool use.";

// Recorded baseline (herdr 0.7.3, 2026-07-11) — see scroll-binding-notes.md. The NOTICE compares
// SEMANTICS, not exact cells: only two facts gate #1639 — "Claude still honors PageUp" (the lever a
// socket-scroll would ride) and "Codex honors NO lever" (why the flip can't ship). The secondary
// levers (Ctrl+Home, MouseWheelUp, Shift+PageUp) are timing-sensitive between runs, so they are
// printed for information but not asserted — otherwise the diagnostic would flap.
const BASELINE_CLAUDE_PAGEUP = true;
const BASELINE_CODEX_ANY_LEVER = false;

function scrollStart(provider: string, argv: string[]): { term: string; tab: string } {
  const r = cli<{ result: { agent: { terminal_id: string; tab_id: string } } }>([
    "agent",
    "start",
    `__verify_scroll_${provider}__`,
    "--cwd",
    "/tmp",
    "--no-focus",
    "--",
    ...argv,
  ]);
  return { term: r.result.agent.terminal_id, tab: r.result.agent.tab_id };
}
function scrollStatus(target: string): string {
  try {
    return cli<{ result: { agent: { agent_status: string } } }>(["agent", "get", target]).result
      .agent.agent_status;
  } catch {
    return "unknown";
  }
}
function scrollVisible(target: string, rows: number): string {
  try {
    return cli<{ result: { read: { text: string } } }>([
      "agent",
      "read",
      target,
      "--source",
      "visible",
      "--lines",
      String(rows),
      "--format",
      "text",
    ]).result.read.text;
  } catch {
    return "";
  }
}
// Standalone numeric lines only — the transcript is 1..150; agent chrome carries stray numbers we
// must not count, so require a line that is JUST the number.
const standaloneNums = (t: string): number[] =>
  [...t.matchAll(/^\s*(\d{1,3})\s*$/gm)].map((m) => Number(m[1]));

interface ProbeRow {
  provider: string;
  error?: string;
  results: { lever: string; scrolled: boolean }[];
}

async function probeAgentScroll(provider: string, argv: string[]): Promise<ProbeRow> {
  const COLS = 80,
    ROWS = 24;
  let tab: string | null = null;
  const results: { lever: string; scrolled: boolean }[] = [];
  try {
    const started = scrollStart(provider, argv);
    tab = started.tab;
    const term = started.term;
    for (let i = 0; i < 100 && scrollStatus(term) === "unknown"; i++) await Bun.sleep(150);

    const ctrl = Bun.spawn(
      [
        herdrBin,
        "terminal",
        "session",
        "control",
        term,
        "--takeover",
        "--cols",
        String(COLS),
        "--rows",
        String(ROWS),
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    let sawFrame = false;
    void (async () => {
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of ctrl.stdout as ReadableStream<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            if ((JSON.parse(line) as { type?: string }).type === "terminal.frame") sawFrame = true;
          } catch {
            /* ignore non-JSON */
          }
        }
      }
    })();
    const key = (text: string) => {
      ctrl.stdin.write(JSON.stringify({ type: "terminal.input", text }) + "\n");
      ctrl.stdin.flush();
    };

    try {
      for (let i = 0; i < 100 && !sawFrame; i++) await Bun.sleep(30);
      // accept a first-run trust/confirm prompt if present (codex shows one on an untrusted cwd)
      if (/trust|Yes, continue|Press enter/i.test(scrollVisible(term, ROWS))) {
        key("\r");
        await Bun.sleep(1500);
      }
      // type + submit the generator prompt, then wait for a tall transcript
      key(GEN_PROMPT);
      await Bun.sleep(500);
      key("\r");
      for (let i = 0; i < 150; i++) {
        if (
          scrollStatus(term) === "idle" &&
          standaloneNums(scrollVisible(term, ROWS)).includes(150)
        )
          break;
        await Bun.sleep(1000);
      }
      await Bun.sleep(1200);

      for (const lever of UP_LEVERS) {
        key(CTRL_END); // restore to bottom (scrollers honor it; no-op for non-scrollers)
        await Bun.sleep(700);
        const before = standaloneNums(scrollVisible(term, ROWS));
        for (let i = 0; i < lever.repeat; i++) {
          key(lever.seq);
          await Bun.sleep(180);
        }
        await Bun.sleep(900);
        const after = standaloneNums(scrollVisible(term, ROWS));
        const bMin = before.length ? Math.min(...before) : Infinity;
        const aMin = after.length ? Math.min(...after) : Infinity;
        // scrolled up ⇔ an EARLIER line became visible than was at the bottom baseline
        results.push({ lever: lever.name, scrolled: aMin < bMin });
      }
      key(CTRL_END);
      await Bun.sleep(300);
    } finally {
      ctrl.kill();
    }
    return { provider, results };
  } catch (err) {
    return { provider, error: err instanceof Error ? err.message : String(err), results };
  } finally {
    if (tab) {
      try {
        cli(["tab", "close", tab]);
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

/** Opt-in mode: the app-binding scroll matrix. Report-only, always exits 0. */
async function runScrollMatrix(): Promise<void> {
  console.log("herdr app-binding scroll matrix (report-only; live agents; ~2-4 min)…\n");
  const rows: ProbeRow[] = [];
  for (const a of SCROLL_AGENTS) rows.push(await probeAgentScroll(a.provider, a.argv));

  const leverNames = UP_LEVERS.map((l) => l.name);
  const header = ["agent".padEnd(8), ...leverNames.map((n) => n.padEnd(14))].join(" ");
  console.log(header);
  console.log("-".repeat(header.length));
  const matrix: Record<string, Record<string, boolean>> = {};
  for (const r of rows) {
    const row: Record<string, boolean> = {};
    matrix[r.provider] = row;
    const cells = leverNames.map((n) => {
      const v = r.results.find((x) => x.lever === n)?.scrolled ?? false;
      row[n] = v;
      return (v ? "scroll" : "----").padEnd(14);
    });
    console.log([r.provider.padEnd(8), ...cells].join(" ") + (r.error ? `  ⚠ ${r.error}` : ""));
  }

  // Semantic divergence NOTICE vs the recorded baseline (see scroll-binding-notes.md).
  const claudePageUp = matrix.claude?.PageUp ?? false;
  const codexLevers = leverNames.filter((n) => matrix.codex?.[n]);
  const codexAny = codexLevers.length > 0;
  const notices: string[] = [];
  if (claudePageUp !== BASELINE_CLAUDE_PAGEUP) {
    notices.push(
      `Claude PageUp changed: baseline=${BASELINE_CLAUDE_PAGEUP ? "scroll" : "----"} now=${claudePageUp ? "scroll" : "----"} — the lever a socket-scroll would ride is no longer as recorded.`,
    );
  }
  if (codexAny !== BASELINE_CODEX_ANY_LEVER) {
    notices.push(
      `Codex now honors a scroll lever (${codexLevers.join(", ")}) — the SHEPHERD_HERDR_SOCKET_TERMINAL flip may have become viable; revisit issue #1639.`,
    );
  }
  console.log();
  if (notices.length) {
    console.log("NOTICE — scroll behavior diverged from the recorded baseline:");
    for (const d of notices) console.log("  - " + d);
  } else {
    console.log(
      "Load-bearing facts match the recorded baseline: Claude honors PageUp, Codex honors none.",
    );
  }
  console.log("\nReport-only: exit 0 regardless (a diagnostic, not a gate).");
}

const RUN_SCROLL = process.argv.includes("--scroll") || process.env.SHEPHERD_VERIFY_SCROLL === "1";
if (RUN_SCROLL) {
  await runScrollMatrix();
} else {
  await runDriftCheck();
}
