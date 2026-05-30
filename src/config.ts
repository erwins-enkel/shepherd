export const config = {
  port: Number(process.env.TANK_PORT ?? 7330),
  dbPath: process.env.TANK_DB ?? `${process.env.HOME}/.tank/tank.db`,
  herdrBin: process.env.HERDR_BIN ?? "herdr",
  herdrSession: process.env.HERDR_SESSION ?? "default",
  ollamaModel: process.env.TANK_NAMER_MODEL ?? "mistral-small3.1:latest",
  ollamaEndpoint: process.env.OLLAMA_URL ?? "http://localhost:11434/api/generate",
};
