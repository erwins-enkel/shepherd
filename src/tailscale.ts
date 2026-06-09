import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { timedAsync } from "./instrument";

const execFileAsync = promisify(execFile);

/**
 * Minimal runner type — injectable for unit tests.
 * Mirrors the promisify(execFile) surface we actually use.
 */
export type TailscaleRunner = (args: string[]) => Promise<{ stdout: string }>;

const defaultRun: TailscaleRunner = (args) =>
  timedAsync("tailscale " + args[0], () => execFileAsync("tailscale", args, { encoding: "utf8" }));

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

// ── serveRange ────────────────────────────────────────────────────────────────

/**
 * Registers each port in `[base, base + count)` with `tailscale serve --bg --https=<port>`.
 *
 * WHY sequential: `tailscale serve` does a read-modify-write on tailscaled's shared
 * serve config. Concurrent execs can race and lose each other's writes — one port's
 * config entry silently disappears. The `for` loop with `await` inside prevents that.
 *
 * WHY `--bg` and bare `127.0.0.1:<port>` target (no `--yes`, no `http://` prefix):
 * this is the form proven to work in README.md:231 and matched by the reaper at
 * src/process-reaper.ts:110 (`/\btailscale\s+serve\b/.test(cmd) && /--bg\b/.test(cmd)`).
 *
 * Best-effort: a failing port logs a warning and the loop continues.
 */
export async function serveRange(
  base: number,
  count: number,
  run: TailscaleRunner = defaultRun,
): Promise<void> {
  for (let port = base; port < base + count; port++) {
    try {
      await run(["serve", "--bg", `--https=${port}`, `127.0.0.1:${port}`]);
    } catch (err) {
      console.warn(`[tailscale] serveRange: failed to serve port ${port}:`, err);
    }
  }
}
