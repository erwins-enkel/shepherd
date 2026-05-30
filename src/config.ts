import { loadForgeMap } from "./forge/load-config";

const forgesPath = process.env.SHEPHERD_FORGES ?? `${process.env.HOME}/.shepherd/forges.json`;

export const config = {
  port: Number(process.env.SHEPHERD_PORT ?? 7330),
  // bind to loopback only; the Tailscale-serve proxy reaches it via 127.0.0.1.
  // set SHEPHERD_HOST=0.0.0.0 to expose on all interfaces (not recommended).
  host: process.env.SHEPHERD_HOST ?? "127.0.0.1",
  dbPath: process.env.SHEPHERD_DB ?? `${process.env.HOME}/.shepherd/shepherd.db`,
  herdrBin: process.env.HERDR_BIN ?? "herdr",
  herdrSession: process.env.HERDR_SESSION ?? "default",
  ollamaModel: process.env.SHEPHERD_NAMER_MODEL ?? "mistral-small3.1:latest",
  ollamaEndpoint: process.env.OLLAMA_URL ?? "http://localhost:11434/api/generate",
  // usage tracking: where Claude Code writes its session JSONL
  claudeProjectsDir:
    process.env.CLAUDE_PROJECTS_DIR ??
    `${process.env.CLAUDE_CONFIG_DIR ?? `${process.env.HOME}/.claude`}/projects`,
  // security
  repoRoot: process.env.SHEPHERD_REPO_ROOT ?? `${process.env.HOME}/Work`,
  allowedOriginHosts: (process.env.SHEPHERD_ALLOWED_HOSTS ?? "localhost,127.0.0.1,::1,[::1]").split(
    ",",
  ),
  token: process.env.SHEPHERD_TOKEN ?? null, // when set, require Authorization: Bearer <token>
  // git host (forge) integration: per-host {type,baseUrl,token,deployWorkflow,mergeMethod}
  forgesPath,
  forges: loadForgeMap(forgesPath),
};
