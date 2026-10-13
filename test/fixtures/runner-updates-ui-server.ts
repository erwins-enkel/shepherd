// Isolated UI fixture: real HTTP/auth/event handling, fake updater operations only.
// Run with bun test/fixtures/runner-updates-ui-server.ts; Ctrl-C removes owned fixture data.
import { startContractServer, withAuth, restoreAuth } from "../contract/harness";
import { writeFileSync } from "node:fs";

await withAuth();
const server = startContractServer();
const herdr = {
  current: "0.8.2",
  latest: "0.9.3",
  updateAvailable: true,
  notes: "herdr fixture notes",
  checkedAt: 1,
  phase: "idle" as const,
  revision: 1,
};
const codex = {
  current: "0.160.1",
  latest: "0.162.1",
  updateAvailable: true,
  notes: null,
  checkedAt: 1,
};
server.deps.herdrUpdates = {
  current: () => herdr,
  status: async () => herdr,
  apply: () => ({ started: false }),
  downgrade: () => ({ started: false }),
  restartServer: async () => ({ started: false, error: "fixture" }),
};
server.deps.codexUpdates = {
  current: () => codex,
  apply: () => ({ started: false }),
  releaseNotes: async () => ({
    current: codex.current,
    latest: codex.latest,
    notes: [{ version: codex.latest, body: "Codex fixture notes" }],
    complete: true,
  }),
};
if (process.env.SHEPHERD_RUNNER_FIXTURE_URL_FILE)
  writeFileSync(process.env.SHEPHERD_RUNNER_FIXTURE_URL_FILE, server.baseUrl);
console.log(`Runner update UI fixture: ${server.baseUrl}`);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    server.stop();
    restoreAuth();
    process.exit(0);
  });
