import { execFile } from "node:child_process";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import { ProcessReaper, scanListeningPortsByWorktree } from "./process-reaper";
import { resolveDevPort } from "./preview";

const execFileAsync = promisify(execFile);

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function gitCommonDir(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--git-common-dir"], {
      cwd: worktreePath,
      encoding: "utf8",
      timeout: 5000,
    });
    const raw = stdout.trim();
    if (!raw) return null;
    return resolve(worktreePath, raw);
  } catch {
    return null;
  }
}

export async function previewScriptExists(path: string | null | undefined): Promise<boolean> {
  if (!path) return false;
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function resolvePreviewStartScriptPath(worktreePath: string): Promise<string | null> {
  const commonDir = await gitCommonDir(worktreePath);
  if (commonDir === null) return null;
  return resolve(commonDir, "shepherd", "preview-start.sh");
}

export async function ensurePreviewStartScript(
  worktreePath: string,
  command: string,
): Promise<string | null> {
  const scriptPath = await resolvePreviewStartScriptPath(worktreePath);
  if (scriptPath === null) return null;
  const dir = resolve(scriptPath, "..");
  const logPath = resolve(dir, "preview-start.log");
  await mkdir(dir, { recursive: true });
  const body = `#!/usr/bin/env bash
set -euo pipefail

WORKTREE_ROOT="\${SHEPHERD_WORKTREE_PATH:-$PWD}"
cd "$WORKTREE_ROOT"
export SHEPHERD_PREVIEW=1
export SHEPHERD_PREVIEW_LOG=\${SHEPHERD_PREVIEW_LOG:-${shellQuote(logPath)}}
COMMAND=${shellQuote(command)}

log() {
  printf '%s\\n' "$*" >> "$SHEPHERD_PREVIEW_LOG"
}

port_is_free() {
  local port="$1"
  ! (echo >"/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1
}

pick_port() {
  local start="\${SHEPHERD_PREVIEW_PORT:-\${SHEPHERD_PREVIEW_PORT_BASE:-5174}}"
  if [[ ! "$start" =~ ^[0-9]+$ ]] || [ "$start" -lt 1 ] || [ "$start" -gt 65535 ]; then
    start=5174
  fi
  local end=$((start + 200))
  if [ "$end" -gt 65535 ]; then
    end=65535
  fi
  local port
  for ((port=start; port<=end; port++)); do
    if port_is_free "$port"; then
      printf '%s\\n' "$port"
      return 0
    fi
  done
  log "no free preview port found from $start to $end"
  return 1
}

install_if_needed() {
  local runner="$1"
  if [ -d node_modules ] || [ ! -f package.json ]; then
    return 0
  fi
  log "installing dependencies in $PWD with $runner"
  case "$runner" in
    bun) bun install ;;
    npm) npm install ;;
    pnpm) pnpm install ;;
    yarn) yarn install ;;
    *) return 1 ;;
  esac
}

run_package_dev() {
  local dir="$1"
  local runner="$2"
  if [ -n "$dir" ]; then
    cd "$WORKTREE_ROOT/$dir"
  fi
  install_if_needed "$runner"
  local port
  port="$(pick_port)"
  printf '%s\\n' "$port" > "$WORKTREE_ROOT/.shepherd-preview"
  export PORT="$port"
  export VITE_PORT="$port"
  log "starting preview command on port $port: $COMMAND"
  case "$runner" in
    bun) exec bun run dev -- --port "$port" ;;
    npm) exec npm run dev -- --port "$port" ;;
    pnpm) exec pnpm run dev -- --port "$port" ;;
    yarn) exec yarn dev --port "$port" ;;
  esac
}

if [[ "$COMMAND" =~ ^cd[[:space:]]+([^;&|]+)[[:space:]]+\\&\\&[[:space:]]+(bun|npm|pnpm|yarn)[[:space:]]+(run[[:space:]]+)?dev$ ]]; then
  run_package_dev "\${BASH_REMATCH[1]}" "\${BASH_REMATCH[2]}"
elif [[ "$COMMAND" =~ ^(bun|npm|pnpm|yarn)[[:space:]]+(run[[:space:]]+)?dev$ ]]; then
  run_package_dev "" "\${BASH_REMATCH[1]}"
fi

log "starting raw preview command: $COMMAND"
exec env bash -lc "$COMMAND"
`;
  await writeFile(scriptPath, body, { encoding: "utf8", mode: 0o700 });
  await chmod(scriptPath, 0o700);
  return scriptPath;
}

export async function startPreviewScript(scriptPath: string, worktreePath: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(scriptPath, {
      cwd: worktreePath,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        SHEPHERD_WORKTREE_PATH: worktreePath,
      },
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
  });
}

/** Injectable seam for `findPreviewDevPort` — defaults spawn the real backend, tests
 *  override to drive the forced-refresh and null-scan branches without `/proc`/`lsof`. */
export interface FindDevPortDeps {
  /** Force the probe snapshot to reflect a dev server started within the coalescing
   *  window (darwin; no-op otherwise). Defaults to the module reaper's refresh. */
  refresh: (opts?: { force?: boolean }) => Promise<void>;
  /** Batched listening-port scan; returns `null` when the snapshot backend can't
   *  support a negative verdict. Defaults to the real `scanListeningPortsByWorktree`. */
  scan: (worktrees: string[]) => Map<string, number[]> | null;
}

// Constructed without explicit probes, so it shares the module-private default
// probes instance — and therefore the SAME snapshot cell as index.ts's shared
// reaper. Refreshing here is visible to the poller's sweeps and the Diagnose row.
const defaultReaper = new ProcessReaper();
const defaultFindDevPortDeps: FindDevPortDeps = {
  refresh: (opts) => defaultReaper.refresh(opts),
  scan: (worktrees) => scanListeningPortsByWorktree(worktrees),
};

export async function findPreviewDevPort(
  worktreePath: string,
  deps: FindDevPortDeps = defaultFindDevPortDeps,
): Promise<number | null> {
  // Force so a dev server started within the coalescing window is seen (else a
  // start click could spawn a second server where an existing one would bind).
  await deps.refresh({ force: true });
  const map = deps.scan([worktreePath]);
  // `null` = unknown (darwin, stale/none cell) — no dev port can be asserted.
  if (map === null) return null;
  const ports = map.get(worktreePath) ?? [];
  return resolveDevPort(ports, worktreePath);
}
