import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SessionStore } from "../src/store";

test("retire telemetry: drops orphaned settings rows, keeps others, idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-store-retire-telemetry-"));
  const dbPath = join(dir, "test.db");
  try {
    const raw = new Database(dbPath);
    raw.run(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    for (const [k, v] of <[string, string][]>[
      ["telemetryConsent", "granted"],
      ["telemetryHealth", '{"lastSentAt":1}'],
      ["criticCli", "codex"],
    ])
      raw.run(`INSERT INTO settings (key, value) VALUES (?, ?)`, [k, v]);
    raw.close();

    const store = new SessionStore(dbPath);
    expect(store.getSetting("telemetryConsent")).toBeNull();
    expect(store.getSetting("telemetryHealth")).toBeNull();
    expect(store.getSetting("criticCli")).toBe("codex");

    // A second open finds nothing to retire.
    expect(() => new SessionStore(dbPath)).not.toThrow();
    expect(new SessionStore(dbPath).getSetting("criticCli")).toBe("codex");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
