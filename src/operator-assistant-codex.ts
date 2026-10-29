/** Dedicated Codex HUD runtime. Never reuse the coding argv or the user's config. */
import {
  openSync,
  closeSync,
  renameSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { codexHome } from "./codex-usage";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { codexLaunchMarker, rolloutHeaders } from "./codex-session-id";
import { operatorAssistantPermissions } from "./operator-assistant-core";
import { config } from "./config";

const exec = promisify(execFile);
export const assistantCodexHome = (cwd: string, id: string) => join(cwd, ".codex-runtime", id);

export function assistantCodexConfig(opts: {
  cwd: string;
  home: string;
  endpoint: string;
  key: string;
  brief: string;
}): string {
  const denied = operatorAssistantPermissions(
    dirname(config.dbPath),
    homedir(),
    config.assistantSpawnDir,
    opts.cwd,
  )
    .deny.filter((r) => r.startsWith("Read("))
    .map((r) =>
      r
        .slice(5, -1)
        .replace(/^~\//, `${homedir()}/`)
        .replace(/^\/\//, "/")
        .replace(/\/\*\*$/, "")
        .replace("/proc/**/environ", "/proc"),
    );
  const state = dirname(config.dbPath);
  const stateFiles = existsSync(state)
    ? readdirSync(state)
        .filter((n) => n.endsWith(".key") || n.includes(".db"))
        .map((n) => join(state, n))
    : [];
  const paths = [
    ...new Set([
      ...denied.filter((p) => !p.includes("*")),
      ...stateFiles,
      config.dbPath,
      `${config.dbPath}-wal`,
      `${config.dbPath}-shm`,
      codexHome(),
      opts.home,
      join(opts.cwd, ".codex-runtime"),
    ]),
  ];
  const files = paths
    .filter((p) => !paths.some((parent) => parent !== p && p.startsWith(`${parent}/`)))
    .map((p) => `${JSON.stringify(p)} = "deny"`)
    .join("\n");
  return `approval_policy = "never"
default_permissions = "assistant"
developer_instructions = ${JSON.stringify(opts.brief)}
web_search = "disabled"
[projects.${JSON.stringify(opts.cwd)}]
trust_level = "trusted"
[features]
shell_tool = false
[agents]
enabled = false
[apps._default]
enabled = false
[permissions.assistant]
extends = ":read-only"
[permissions.assistant.filesystem]
${files}
[permissions.assistant.network]
enabled = false
[mcp_servers.shepherd]
url = ${JSON.stringify(opts.endpoint)}
required = true
[mcp_servers.shepherd.http_headers]
x-shepherd-ingress-key = ${JSON.stringify(opts.key)}
`;
}

export function prepareCodexAssistant(opts: {
  cwd: string;
  id: string;
  endpoint: string;
  key: string;
  brief: string;
}): string {
  const home = assistantCodexHome(opts.cwd, opts.id);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // Preserve an isolated refresh until the operator's source auth changes (e.g. re-login).
  const auth = join(home, "auth.json");
  const source = join(codexHome(), "auth.json");
  const stamp = join(home, "auth-source.sha256");
  if (existsSync(source)) {
    const credentials = readFileSync(source);
    const digest = createHash("sha256").update(credentials).digest("hex");
    if (!existsSync(auth) || !existsSync(stamp) || readFileSync(stamp, "utf8") !== digest) {
      // Publish one source snapshot atomically; never truncate or follow the destination.
      const temp = join(home, `auth-${crypto.randomUUID()}.tmp`);
      const fd = openSync(temp, "wx", 0o600);
      try {
        writeFileSync(fd, credentials);
        renameSync(temp, auth);
      } finally {
        closeSync(fd);
        rmSync(temp, { force: true });
      }
      writeFileSync(stamp, digest, { mode: 0o600 });
    }
  }
  writeFileSync(join(home, "config.toml"), assistantCodexConfig({ ...opts, home }), {
    mode: 0o600,
  });
  return home;
}

export function buildCodexAssistantArgv(opts: {
  home: string;
  resumeId?: string | null;
  launchId: string;
  model: string | null;
  effort: string | null;
  prompt?: string;
}): string[] {
  const argv = ["env", `CODEX_HOME=${opts.home}`, config.codexBin];
  if (opts.resumeId) argv.push("resume", opts.resumeId);
  argv.push("--no-alt-screen", "--no-daemon", "--strict-config");
  if (opts.model) argv.push("--model", opts.model);
  if (opts.effort) argv.push("-c", `model_reasoning_effort=${opts.effort}`);
  if (!opts.resumeId && opts.prompt) argv.push(`${codexLaunchMarker(opts.launchId)}${opts.prompt}`);
  return argv;
}

/** Same OS-enforced profile as the model's tools; argv is never executed by a host shell. */
export async function runAssistantShell(
  home: string,
  cwd: string,
  argv: string[],
): Promise<string> {
  const result = await exec(
    Bun.which(config.codexBin) ?? config.codexBin,
    [
      "sandbox",
      "--permission-profile",
      "assistant",
      "--cd",
      cwd,
      "--",
      "/usr/bin/env",
      "-i",
      "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
      `HOME=${homedir()}`,
      "LANG=C.UTF-8",
      ...argv,
    ],
    {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: homedir(),
        CODEX_HOME: home,
        LANG: "C.UTF-8",
      },
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    },
  );
  return `${result.stdout}${result.stderr}`;
}

let supported: Promise<boolean> | undefined;
/** Verify the actual installed sandbox without sending a request to a model. */
export function codexAssistantSupported(): Promise<boolean> {
  return (supported ??= (async () => {
    const root = join(config.operatorAssistantDir, `.probe-${crypto.randomUUID()}`);
    const home = join(root, "home");
    const write = join(root, "write-probe");
    try {
      mkdirSync(home, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(home, "config.toml"),
        assistantCodexConfig({
          cwd: root,
          home,
          endpoint: "http://127.0.0.1:1/mcp",
          key: "probe",
          brief: "probe",
        }),
        { mode: 0o600 },
      );
      const { stdout } = await exec(config.codexBin, ["--help"], {
        timeout: 5000,
        maxBuffer: 32 * 1024,
      });
      if (!stdout.includes("--no-daemon") || !stdout.includes("--strict-config")) return false;
      const output = await runAssistantShell(home, root, [
        "sh",
        "-c",
        'if cat "$1" >/dev/null 2>&1; then exit 21; fi; if touch "$2" 2>/dev/null; then exit 22; fi; printf protected',
        "probe",
        join(home, "config.toml"),
        write,
      ]);
      return output === "protected";
    } catch {
      return false;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  })());
}

/** A server-created per-session home is an ownership boundary, never a shared-cwd recency guess.
 * Multiple native conversations (e.g. a terminal /fork) are ambiguous and remain manual. */
export function findAssistantCodexSessionId(home: string, cwd: string): string | null {
  const ids = new Set<string>();
  for (const header of rolloutHeaders(home)) {
    if (header.cwd === cwd && header.id && header.source && header.source !== "exec")
      ids.add(header.id);
  }
  return ids.size === 1 ? [...ids][0]! : null;
}

export function removeCodexAssistantSecrets(cwd: string, id: string): void {
  for (const file of ["auth.json", "config.toml", "auth-source.sha256"]) {
    try {
      rmSync(join(assistantCodexHome(cwd, id), file), { force: true });
    } catch {
      console.warn("[assistant] could not remove private runtime file");
    }
  }
}
