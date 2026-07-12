import type { HerdrDriver } from "./herdr";
import { parseUsageFrame, type UsageProbe } from "./usage-limits";
import { config } from "./config";
import { compileCacheDir } from "./tmp-sweep";
import { isApiKeyMode } from "./spawn-auth";
import { claudeConfigPath, readRepoRootTrusted, trustRepoRoot } from "./claude-trust";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const decoder = new TextDecoder();

/**
 * Reserved herdr name/label for the ephemeral usage probe. The underscores are load-bearing:
 * prompt-derived session slugs are `[a-z0-9-]` only (see namer.ts), so no real session can ever
 * collide with this name. Anything reaped by `name === PROBE_NAME` is therefore unambiguously a
 * probe — never a user's session. A bare "usage-probe" would NOT be safe: `normalize("usage
 * probe")` slugs to exactly that, so a user prompt could take the name and get killed mid-turn.
 */
export const PROBE_NAME = "__usage_probe__";

/**
 * Wait for a usable `/usage` capture, then return the raw buffer (or null if the week window never
 * rendered). Pure + injectable (`read` yields the live buffer, `sleep` the delay) so the gating
 * logic is unit-testable without a real PTY.
 *
 * Two phases:
 *  1. Wait (up to `weekTries`) for the weekly window's "Resets …" label — a pct-only partial render
 *     would calibrate against a guessed anchor, so prefer the labelled frame.
 *  2. The "Usage credits" panel renders BELOW the week gauge, so it streams into the buffer a cycle
 *     or two AFTER week's label. Gating on week alone returns before credits lands → its snapshot
 *     never advances and the gauge reads perpetually stale. Give credits a bounded grace (up to
 *     `creditTries`), returning the instant it parses. A true no-credit account simply waits the
 *     bounded grace and falls through to the same buffer — nothing is fabricated.
 *
 * The grace is intentionally a fixed bound rather than gated on a "has-credits" signal or an
 * early-bail when the buffer stops growing: those save ~`creditTries`s only on no-credit accounts,
 * whose grace is paid **solely by the background calibrate** (the manual REFRESH control lives in
 * CreditDetail, rendered only when `credits != null`, so no user ever waits on it). An early-bail
 * would also risk missing credits if the TUI pauses streaming between the week gauge and the panel
 * below it — trading away the very reliability this wait exists to provide. Background-only latency
 * isn't worth that.
 */
export async function awaitUsageFrame(
  read: () => string,
  sleep: (ms: number) => Promise<void>,
  weekTries = 12,
  creditTries = 6,
): Promise<string | null> {
  const frame = () => parseUsageFrame(read(), 0);
  for (let i = 0; i < weekTries && !frame().week?.resetLabel; i++) await sleep(1000);
  // Skip the grace entirely when week never rendered (frame().week falsy) — there's nothing to wait
  // for and the scrape has already failed.
  for (let i = 0; i < creditTries && frame().week && !frame().credits; i++) await sleep(1000);
  return frame().week ? read() : null;
}

/**
 * Drives an ephemeral interactive `claude`, sends `/usage`, and captures the rendered panel.
 *
 * herdr owns the agent (lifecycle + cleanup), but the panel only renders legibly when a PTY of a
 * real size is attached — so I/O goes through the same Node `pty-attach.mjs` helper the browser
 * bridge uses (node-pty is broken under Bun). ToS-pure: a real interactive session, no `-p`/SDK;
 * `/usage` makes no model call (zero token cost).
 */
export class HerdrUsageProbe implements UsageProbe {
  private readTrusted: () => Promise<boolean>;
  private trust: () => Promise<void>;

  constructor(
    private herdr: Pick<HerdrDriver, "start" | "stop" | "list">,
    private cwd: string = config.repoRoot,
    private helperPath = new URL("./pty-attach.mjs", import.meta.url).pathname,
    // Trust pre-seed, injectable for tests. Defaults resolve the SAME `.claude.json`
    // Claude reads (config-dir-aware, see claude-trust.ts) and target this probe's cwd.
    deps: {
      readTrusted?: () => Promise<boolean>;
      trust?: () => Promise<void>;
    } = {},
  ) {
    const configPath = claudeConfigPath(process.env.HOME ?? "", config.claudeDir);
    this.readTrusted = deps.readTrusted ?? (() => readRepoRootTrusted(configPath, this.cwd));
    this.trust = deps.trust ?? (() => trustRepoRoot(configPath, this.cwd));
  }

  /**
   * Close every lingering probe agent (and its herdr tab/pane). Probes run under the reserved
   * {@link PROBE_NAME}, which no prompt-derived session slug can produce, so matching on it can
   * never reap a user's session. Self-healing reaper: catches any probe agent left *running* in
   * `agent list` after its own cleanup didn't run (e.g. the daemon was killed mid-probe, or the
   * post-start lookup threw while the agent itself was alive). It can't reach a tab whose
   * `agent start` failed outright — no agent is registered, so nothing shows in the list (the
   * boot/hourly tab-reaper sweep covers that husk).
   */
  private async sweep(): Promise<void> {
    for (const a of this.herdr.list()) {
      if (a.name !== PROBE_NAME) continue;
      try {
        await this.herdr.stop(a.terminalId);
      } catch {
        /* best-effort */
      }
    }
  }

  async scrape(): Promise<string | null> {
    // subscription-only; never spawn under api-key auth — see usage-limits calibrate short-circuit
    if (isApiKeyMode()) return null;
    // Reap leftovers from any prior run that didn't clean up after itself, so probe tabs can't
    // accumulate in herdr over time.
    await this.sweep();

    // Pre-seed folder trust so claude boots straight to the REPL. An untrusted cwd makes claude
    // open the "Do you trust the files in this folder?" dialog (NOT suppressed by
    // --dangerously-skip-permissions), which eats our /usage keystrokes → null scrape (#1075).
    // Read-gated so we write at most once per cwd. Best-effort: a trust read/write failure
    // (EACCES/ENOSPC, malformed config, race) must NEVER reject scrape() — calibrate()
    // (usage-limits.ts) awaits it unguarded, so a rejection would surface as a refresh-route 500.
    // On failure we fall through to the spawn; an untrusted folder then just yields the usual null.
    try {
      if (!(await this.readTrusted())) await this.trust();
    } catch (err) {
      console.warn("[usage-probe] trust pre-seed failed; continuing", err);
    }

    let terminalId: string;
    try {
      // Resolve the new agent by list diff: herdr.start()'s cwd-based resolution is ambiguous if a
      // prior probe still lingers in the same cwd, and would hand back a stale/dead terminal id.
      const before = new Set(this.herdr.list().map((a) => a.terminalId));
      const started = await this.herdr.start(PROBE_NAME, this.cwd, [
        "claude",
        "--dangerously-skip-permissions",
      ]);
      const fresh = this.herdr.list().find((a) => !before.has(a.terminalId));
      terminalId = fresh?.terminalId ?? started.terminalId;
    } catch {
      // start() can throw after the agent is already running (the post-start cwd lookup found no
      // match) — reap that live probe before bailing. (A failed `agent start` leaves a tab with no
      // agent, which the sweep can't see; pre-existing gap, not handled here.)
      await this.sweep();
      return null;
    }

    const proc = Bun.spawn(["node", this.helperPath, terminalId, "120", "40"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe", // must be piped + drained; "ignore" can stall the helper's stdout under Bun
      // Pin the V8 compile cache to disk, off the tmpfs — same rationale as the herdr spawn
      // shim: these direct `node` helpers otherwise write `node-compile-cache` into TMPDIR and
      // accrete inodes there until the tmpfs runs dry (#560).
      env: { ...process.env, HERDR_BIN: config.herdrBin, NODE_COMPILE_CACHE: compileCacheDir() },
    });

    let buf = "";
    const pump = (async () => {
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
      }
    })();
    const drainErr = (async () => {
      for await (const _ of proc.stderr as ReadableStream<Uint8Array>) void _;
    })();

    // Drive the panel open, then hand off to awaitUsageFrame for the parse-gated wait (week label
    // first, then a bounded grace for the trailing credits panel — see its docstring).
    try {
      // type the slash command, let the command menu register, THEN submit with Enter separately —
      // a combined "/usage\r" runs before the menu is ready and the panel never opens.
      await sleep(5000); // let claude boot
      // Awaited (not fire-and-forget) so a failed write to a dead probe pane lands in the catch
      // below as a clean `null`, rather than escaping as an unhandled rejection.
      await proc.stdin.write("/usage");
      await proc.stdin.flush();
      await sleep(900);
      await proc.stdin.write("\r");
      await proc.stdin.flush();
      return await awaitUsageFrame(() => buf, sleep);
    } catch {
      return null;
    } finally {
      try {
        proc.kill();
      } catch {
        /* noop */
      }
      void pump.catch(() => {});
      void drainErr.catch(() => {});
      // Sweep by name rather than stop(terminalId): closes this probe AND any straggler, and
      // doesn't depend on terminalId having resolved. Awaited: `sweep`'s `herdr.list()` loop
      // header can throw synchronously (outside the per-item try), so an un-awaited call here
      // would reject a detached promise from this `finally` with no handler.
      await this.sweep();
    }
  }
}
