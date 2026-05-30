export const config = {
  port: Number(process.env.TANK_PORT ?? 7330),
  dbPath: process.env.TANK_DB ?? `${process.env.HOME}/.tank/tank.db`,
  herdrBin: process.env.HERDR_BIN ?? "herdr",
  herdrSession: process.env.HERDR_SESSION ?? "default",
  ollamaModel: process.env.TANK_NAMER_MODEL ?? "mistral-small3.1:latest",
  ollamaEndpoint: process.env.OLLAMA_URL ?? "http://localhost:11434/api/generate",
  // security
  repoRoot: process.env.TANK_REPO_ROOT ?? `${process.env.HOME}/Work`,
  allowedOriginHosts: (process.env.TANK_ALLOWED_HOSTS ?? "localhost,127.0.0.1,::1,[::1]").split(
    ",",
  ),
  token: process.env.TANK_TOKEN ?? null, // when set, require Authorization: Bearer <token>
};
