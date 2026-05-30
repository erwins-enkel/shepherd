import type { HerdrDriver } from "./herdr";
import { parseUsageFrame, type UsageProbe } from "./usage-limits";
import { config } from "./config";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const decoder = new TextDecoder();

/**
 * Drives an ephemeral interactive `claude`, sends `/usage`, and captures the rendered panel.
 *
 * herdr owns the agent (lifecycle + cleanup), but the panel only renders legibly when a PTY of a
 * real size is attached — so I/O goes through the same Node `pty-attach.mjs` helper the browser
 * bridge uses (node-pty is broken under Bun). ToS-pure: a real interactive session, no `-p`/SDK;
 * `/usage` makes no model call (zero token cost).
 */
export class HerdrUsageProbe implements UsageProbe {
  constructor(
    private herdr: Pick<HerdrDriver, "start" | "stop" | "list">,
    private cwd: string = config.repoRoot,
    private helperPath = new URL("./pty-attach.mjs", import.meta.url).pathname,
  ) {}

  async scrape(): Promise<string | null> {
    let terminalId: string;
    try {
      // Resolve the new agent by list diff: herdr.start()'s cwd-based resolution is ambiguous if a
      // prior probe still lingers in the same cwd, and would hand back a stale/dead terminal id.
      const before = new Set(this.herdr.list().map((a) => a.terminalId));
      const started = this.herdr.start("usage-probe", this.cwd, [
        "claude",
        "--dangerously-skip-permissions",
      ]);
      const fresh = this.herdr.list().find((a) => !before.has(a.terminalId));
      terminalId = fresh?.terminalId ?? started.terminalId;
    } catch {
      return null;
    }

    const proc = Bun.spawn(["node", this.helperPath, terminalId, "120", "40"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe", // must be piped + drained; "ignore" can stall the helper's stdout under Bun
      env: { ...process.env, HERDR_BIN: config.herdrBin },
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

    // Gate on whether the panel actually parses (parseUsageFrame strips ANSI before matching —
    // a whitespace-only check fails since color codes sit between "Current" and "week"). The
    // session/week %s render immediately; only the breakdown below waits on the local-session scan.
    const hasPanel = () => parseUsageFrame(buf, 0).week !== null;

    try {
      // type the slash command, let the command menu register, THEN submit with Enter separately —
      // a combined "/usage\r" runs before the menu is ready and the panel never opens.
      await sleep(5000); // let claude boot
      proc.stdin.write("/usage");
      proc.stdin.flush();
      await sleep(900);
      proc.stdin.write("\r");
      proc.stdin.flush();
      for (let i = 0; i < 12 && !hasPanel(); i++) await sleep(1000);
      return hasPanel() ? buf : null;
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
      try {
        this.herdr.stop(terminalId);
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}
