import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("power pane ownership is explicit, durable, deduplicated and scoped to the canonical DB", () => {
  const directory = mkdtempSync(join(tmpdir(), "power-panes-"));
  try {
    const db = join(directory, "server.db");
    const alias = join(directory, "alias.db");
    writeFileSync(db, "");
    symlinkSync(db, alias);
    const module = new URL("../src/power-panes.ts", import.meta.url).pathname;
    const script = `
      import { enablePowerPaneJournal, recordPowerPane } from ${JSON.stringify(module)};
      recordPowerPane("unconfigured-fake-pane");
      enablePowerPaneJournal(${JSON.stringify(alias)});
      recordPowerPane("main-pane");
      recordPowerPane("auxiliary-pane");
      recordPowerPane("main-pane");
    `;
    const result = Bun.spawnSync([process.execPath, "-e", script]);
    expect(result.exitCode).toBe(0);
    expect(
      readFileSync(db + ".power-panes", "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual(["main-pane", "auxiliary-pane"]);
    // Starting a new server process preserves earlier ownership records.
    expect(Bun.spawnSync([process.execPath, "-e", script]).exitCode).toBe(0);
    expect(
      readFileSync(db + ".power-panes", "utf8")
        .trim()
        .split("\n"),
    ).toHaveLength(4);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
