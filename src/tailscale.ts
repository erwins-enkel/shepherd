import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { execFileSync, timedAsync } from "./instrument";

const execFileAsync = promisify(execFile);

/**
 * Minimal runner type — injectable for unit tests.
 * Mirrors the promisify(execFile) surface we actually use.
 */
export type TailscaleRunner = (args: string[]) => Promise<{ stdout: string }>;

const defaultRun: TailscaleRunner = (args) =>
  timedAsync("tailscale " + args[0], () =>
    execFileAsync("tailscale", args, { encoding: "utf8", timeout: 5000 }),
  );

// ── resolveNodeHost ───────────────────────────────────────────────────────────

/**
 * Returns this node's own Tailscale hostname (e.g. `"backontop.chicken-beardie.ts.net"`)
 * by parsing `tailscale status --json`.
 *
 * WHY: when Shepherd's HUD is fronted by a Tailscale Service identity (a different
 * DNS name than the machine's own node), `Self.DNSName` is the only reliable way to
 * construct preview URLs that resolve from the tailnet — the Service front may live
 * under a different hostname entirely.
 *
 * Returns `null` on any failure (binary absent, daemon not running, JSON malformed,
 * `Self`/`Self.DNSName` missing or empty). Never throws.
 */
export async function resolveNodeHost(run: TailscaleRunner = defaultRun): Promise<string | null> {
  try {
    const { stdout } = await run(["status", "--json"]);
    const parsed: unknown = JSON.parse(stdout);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      !("Self" in parsed) ||
      parsed.Self === null ||
      typeof parsed.Self !== "object" ||
      !("DNSName" in parsed.Self) ||
      typeof parsed.Self.DNSName !== "string" ||
      parsed.Self.DNSName === ""
    ) {
      return null;
    }
    // Strip trailing dot: "backontop.chicken-beardie.ts.net." → "backontop.chicken-beardie.ts.net"
    return parsed.Self.DNSName.replace(/\.$/, "");
  } catch {
    return null;
  }
}

// ── TailscaleServeService ─────────────────────────────────────────────────────

export type ServeState = "ok" | "failed";
export type TailscaleRunnerSync = (args: string[]) => void;

// Kept tight on purpose: a healthy local `tailscale serve … off` is sub-second, so this
// only bites when tailscaled hangs — exactly when we want to bail fast on shutdown rather
// than block `systemctl stop`. Anything skipped self-heals on the next boot's reconcile.
const SYNC_TIMEOUT_MS = 1500;
const defaultRunSync: TailscaleRunnerSync = (args) => {
  execFileSync("tailscale", args, { timeout: SYNC_TIMEOUT_MS, stdio: "ignore" });
};

export interface TailscaleServeOpts {
  base: number;
  count: number;
  /** true = config.previewAutoServe && config.previewHost != null */
  readonly enabled: boolean;
  /** Fires after a register/unregister settles, so the change can be surfaced
   *  (wiring emits it as session:preview-serve). serve: "ok"|"failed" on register, null on release. */
  onChange?: (id: string, previewPort: number | null, serve: ServeState | null) => void;
  /** Async hot path; default defaultRun */
  run?: TailscaleRunner;
  /** Sync shutdown path; default defaultRunSync */
  runSync?: TailscaleRunnerSync;
}

/**
 * Dynamically (un)registers per-slot `tailscale serve` mappings as preview
 * listeners bind/tear down. ALL mutations run through ONE sequential queue
 * because `tailscale serve` read-modify-writes shared config — concurrent
 * execs race and lose entries (see serveRange history / removed eager path).
 */
export class TailscaleServeService {
  private byId = new Map<string, { port: number; state: ServeState }>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private opts: TailscaleServeOpts) {}

  private get run() {
    return this.opts.run ?? defaultRun;
  }

  private enqueue(op: () => Promise<void>): Promise<void> {
    const next = this.queue.catch(() => {}).then(op);
    this.queue = next;
    return next;
  }

  private fire(id: string, port: number | null, serve: ServeState | null) {
    try {
      this.opts.onChange?.(id, port, serve);
    } catch (err) {
      console.warn(`[tailscale-serve] onChange threw for ${id}:`, err);
    }
  }

  register(id: string, port: number): Promise<void> {
    if (!this.opts.enabled) return Promise.resolve();
    return this.enqueue(async () => {
      try {
        await this.run(["serve", "--bg", `--https=${port}`, `127.0.0.1:${port}`]);
        this.byId.set(id, { port, state: "ok" });
        this.fire(id, port, "ok");
      } catch (err) {
        console.warn(`[tailscale-serve] register failed for ${id} port ${port}:`, err);
        this.byId.set(id, { port, state: "failed" });
        this.fire(id, port, "failed");
      }
    });
  }

  unregister(id: string): Promise<void> {
    if (!this.opts.enabled) return Promise.resolve();
    return this.enqueue(async () => {
      const entry = this.byId.get(id);
      if (!entry) return;
      try {
        await this.run(["serve", `--https=${entry.port}`, "off"]);
      } catch (err) {
        console.warn(`[tailscale-serve] unregister failed for ${id} port ${entry.port}:`, err);
      }
      this.byId.delete(id);
      this.fire(id, null, null);
    });
  }

  /**
   * Clear the whole preview range at boot (recover stale mappings from a crashed
   * prior run). One queued op running the offs sequentially; tolerates per-port failure.
   * NOTE: this also removes any pre-existing MANUAL `tailscale serve` mappings in the
   * range — by design, since with SHEPHERD_PREVIEW_AUTO_SERVE on (default) Shepherd owns
   * the range and registers slots dynamically. The startup log below makes that explicit
   * so the ownership transfer isn't silent for operators upgrading from a manual setup.
   */
  reconcileStartup(): Promise<void> {
    if (!this.opts.enabled) return Promise.resolve();
    const last = this.opts.base + this.opts.count - 1;
    console.info(
      `[tailscale-serve] clearing preview range ${this.opts.base}-${last} for dynamic ` +
        `management (removes any manual \`tailscale serve\` mappings in this range; set ` +
        `SHEPHERD_PREVIEW_AUTO_SERVE=0 to manage the range manually instead)`,
    );
    return this.enqueue(async () => {
      for (let port = this.opts.base; port < this.opts.base + this.opts.count; port++) {
        try {
          await this.run(["serve", `--https=${port}`, "off"]);
        } catch {
          /* benign */
        }
      }
    });
  }

  /**
   * Synchronous shutdown teardown (process exit/SIGTERM): off only the slots we
   * registered (≤ active previews, capped at `count`). Worst-case wall time is
   * registered-slots × SYNC_TIMEOUT_MS (≤ 16 × 1.5s = 24s) and only approaches that
   * if tailscaled is hung; a healthy daemon offs each slot in well under a second.
   * Best-effort: any slot that errors/times out is skipped and self-heals on the next
   * boot's reconcileStartup (which clears the whole range), so we never block exit on it.
   */
  stopAll(): void {
    if (!this.opts.enabled) return;
    const runSync = this.opts.runSync ?? defaultRunSync;
    for (const { port } of this.byId.values()) {
      try {
        runSync(["serve", `--https=${port}`, "off"]);
      } catch {
        /* best effort */
      }
    }
    this.byId.clear();
  }

  snapshot(): Record<string, ServeState> {
    if (!this.opts.enabled) return {};
    return Object.fromEntries([...this.byId].map(([id, e]) => [id, e.state]));
  }
}
