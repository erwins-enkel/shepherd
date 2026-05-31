import { execFileSync, spawn } from "node:child_process";
import { config } from "./config";
import type { HerdrUpdateStatus } from "./types";

export type { HerdrUpdateStatus };

/** Numeric major.minor.patch comparison. Returns >0 if a>b, <0 if a<b, 0 if equal.
 *  Missing/garbage segments coerce to 0, so "0.6" compares as "0.6.0". */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number(n) || 0);
  const pb = b.split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export interface HerdrUpdateDeps {
  /** inject point for tests; defaults to running the herdr binary's --version */
  versionRunner?: () => string;
  /** inject point for tests; defaults to fetching herdr.dev/latest.json */
  fetchLatest?: () => Promise<{ version: string; notes?: string }>;
  /** inject point for tests; defaults to launching `herdr update` detached */
  launch?: () => void;
  /** called for each log line streamed from the running update; default: no-op */
  onLog?: (line: string) => void;
  /**
   * inject point for tests: start following the update log and call onLine for
   * each line. Defaults to tailing `journalctl --user -u herdr-update`.
   * Wrapped in try/catch so a missing journalctl never breaks apply().
   */
  follow?: (onLine: (line: string) => void) => void;
}

const SEMVER_RE = /(\d+\.\d+\.\d+)/;
const LATEST_URL = "https://herdr.dev/latest.json";

/**
 * Tracks whether a newer herdr (the external terminal multiplexer Shepherd
 * drives) is published upstream and, on demand, drives `herdr update` for the
 * operator. It surfaces a badge keyed off `updateAvailable`.
 *
 * The check parses the installed version from `herdr --version` and compares it
 * against herdr.dev/latest.json. It is fail-safe: any error (binary missing,
 * network down, malformed payload) yields updateAvailable:false, so a broken
 * check can never raise a false badge.
 *
 * `apply()` is destructive: `herdr update` restarts the herdr server, ending
 * every live agent pane. Shepherd itself runs as the `shepherd.service` --user
 * unit (NOT inside herdr), so it can launch the update exactly like the git
 * self-update launches the deploy script.
 */
export class HerdrUpdateService {
  private versionRunner: () => string;
  private fetchLatest: () => Promise<{ version: string; notes?: string }>;
  private launch: () => void;
  private onLog: (line: string) => void;
  private follow: (onLine: (line: string) => void) => void;
  private last: HerdrUpdateStatus | null = null;
  private applying = false;

  constructor(deps: HerdrUpdateDeps = {}) {
    this.versionRunner =
      deps.versionRunner ??
      (() => execFileSync(config.herdrBin, ["--version"], { encoding: "utf8" }));
    this.fetchLatest =
      deps.fetchLatest ??
      (() =>
        fetch(LATEST_URL).then((r) => r.json() as Promise<{ version: string; notes?: string }>));
    this.launch = deps.launch ?? (() => this.defaultLaunch());
    this.onLog = deps.onLog ?? (() => {});
    this.follow = deps.follow ?? ((onLine) => this.defaultFollow(onLine));
  }

  /**
   * Tail the systemd journal for the herdr-update transient unit and call
   * onLine for each non-empty output line. Runs entirely in the background;
   * errors (e.g. journalctl not found) are swallowed so they never affect apply().
   */
  private defaultFollow(onLine: (line: string) => void): void {
    try {
      const child = spawn(
        "journalctl",
        ["--user", "-u", "herdr-update", "-f", "-o", "cat", "-n", "0"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let buf = "";
      const handleChunk = (chunk: Buffer | string) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trimEnd();
          if (trimmed) onLine(trimmed);
        }
      };
      child.stdout?.on("data", handleChunk);
      child.stderr?.on("data", handleChunk);
      // keep a ref so GC doesn't collect the child before shepherd restarts
      child.unref();
    } catch {
      // journalctl not available — fall back silently to the static busy text
    }
  }

  /** Launch `herdr update` in its own transient systemd scope so it survives the
   *  shepherd restart it triggers (a child in the service cgroup would be killed
   *  mid-update). `herdr update` must run outside a herdr session — the transient
   *  unit gets a clean environment, so it qualifies. It restarts the herdr server
   *  (ending live agent panes), after which we restart shepherd so it re-establishes
   *  its herdr session and clients reconnect to a fresh build. */
  private defaultLaunch(): void {
    // forward our PATH: a transient --user unit gets a bare environment, but the
    // command needs herdr/systemctl, which live on the service's PATH.
    const args = ["--user", "--collect", "--unit=herdr-update"];
    if (process.env.PATH) args.push(`--setenv=PATH=${process.env.PATH}`);
    args.push("bash", "-lc", "herdr update && systemctl --user restart shepherd");
    const child = spawn("systemd-run", args, { stdio: "ignore" });
    child.unref();
  }

  /** Last computed status, or null before the first check. */
  current(): HerdrUpdateStatus | null {
    return this.last;
  }

  /** Kick off the detached `herdr update`. Guards against double-launch within a
   *  single process lifetime; returns whether it actually started. */
  apply(): { started: boolean } {
    if (this.applying) return { started: false };
    this.applying = true;
    this.launch();
    // Start streaming the journal output; wrapped so a failure never surfaces.
    try {
      this.follow((line) => this.onLog(line));
    } catch {
      // follow implementation threw synchronously — ignore
    }
    return { started: true };
  }

  /** Re-read the installed herdr version and the latest published one, then
   *  compare. On any failure returns updateAvailable:false with an error set. */
  async check(now: number): Promise<HerdrUpdateStatus> {
    try {
      const currentMatch = SEMVER_RE.exec(this.versionRunner());
      const current = currentMatch ? currentMatch[1]! : null;

      const latestRaw = await this.fetchLatest();
      const latestMatch = latestRaw?.version ? SEMVER_RE.exec(latestRaw.version) : null;
      const latest = latestMatch ? latestMatch[1]! : null;

      const updateAvailable = !!current && !!latest && compareSemver(latest, current) > 0;

      this.last = {
        current,
        latest,
        updateAvailable,
        notes: updateAvailable ? (latestRaw.notes ?? null) : null,
        checkedAt: now,
      };
    } catch (e) {
      this.last = {
        current: this.last?.current ?? null,
        latest: null,
        updateAvailable: false,
        notes: null,
        checkedAt: now,
        error: e instanceof Error ? e.message : "herdr update check failed",
      };
    }
    return this.last;
  }
}
