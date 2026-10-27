import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  assertModelAvailable,
  createAccountModels,
  isMythosModel,
  ModelUnavailableError,
  MYTHOS_MODEL,
  parseCatalog,
} from "../src/claude-account-models";

const ORG = "7d38fbdf-ef99-4f6a-b414-7780d17fb40f";
const OTHER_ORG = "00000000-0000-4000-8000-000000000000";

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A custom CLAUDE_CONFIG_DIR, so `.claude.json` lives INSIDE it (see claudeConfigPath). */
function claudeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "account-models-"));
  dirs.push(dir);
  return dir;
}

function writeConfig(dir: string, cfg: unknown): void {
  writeFileSync(join(dir, ".claude.json"), JSON.stringify(cfg));
}

function writeCatalog(
  dir: string,
  name: string,
  ids: string[],
  fetchedAt = 1,
  version = 2,
): string {
  const catalogDir = join(dir, "cache", "model-catalog");
  mkdirSync(catalogDir, { recursive: true });
  const path = join(catalogDir, name);
  writeFileSync(
    path,
    JSON.stringify({
      version,
      fetchedAt,
      catalog: { config: { models: ids.map((id) => ({ id })) } },
    }),
  );
  return path;
}

const loggedIn = (extra: object = {}) => ({ oauthAccount: { organizationUuid: ORG }, ...extra });
const available = (dir: string) =>
  createAccountModels({ home: "/nonexistent", claudeDir: dir }).mythosAvailable();

describe("isMythosModel / assertModelAvailable", () => {
  test("matches pinned Mythos ids only", () => {
    expect(isMythosModel("claude-mythos-5-1")).toBe(true);
    expect(isMythosModel("claude-fable-5-1")).toBe(false);
    expect(isMythosModel(null)).toBe(false);
  });

  test("throws for Mythos only when unavailable", () => {
    const no = () => false;
    expect(() => assertModelAvailable(MYTHOS_MODEL, no)).toThrow(ModelUnavailableError);
    expect(() => assertModelAvailable(MYTHOS_MODEL, () => true)).not.toThrow();
    expect(() => assertModelAvailable("opus", no)).not.toThrow();
    expect(() => assertModelAvailable(null, no)).not.toThrow();
  });
});

describe("parseCatalog", () => {
  test("rejects an unknown version or shape", () => {
    expect(parseCatalog({ version: 3, catalog: { config: { models: [] } } })).toBeNull();
    expect(parseCatalog({ version: 2, catalog: {} })).toBeNull();
    expect(parseCatalog("nope")).toBeNull();
  });
});

describe("createAccountModels().mythosAvailable", () => {
  test("served catalog for the logged-in org lists Mythos ⇒ available", () => {
    const dir = claudeDir();
    writeConfig(dir, loggedIn());
    writeCatalog(dir, `${ORG}-ea9b5ce3c4f1-cc.json`, ["claude-opus-5-5", MYTHOS_MODEL]);
    expect(available(dir)).toBe(true);
  });

  test("served catalog without Mythos ⇒ unavailable, even if the options cache has it", () => {
    const dir = claudeDir();
    writeConfig(dir, loggedIn({ additionalModelOptionsCache: [{ value: MYTHOS_MODEL }] }));
    writeCatalog(dir, `${ORG}-ea9b5ce3c4f1-cc.json`, ["claude-opus-5-5"]);
    expect(available(dir)).toBe(false);
  });

  test("another org's catalog is ignored", () => {
    const dir = claudeDir();
    writeConfig(dir, loggedIn());
    writeCatalog(dir, `${OTHER_ORG}-ea9b5ce3c4f1-cc.json`, [MYTHOS_MODEL]);
    expect(available(dir)).toBe(false);
  });

  test("no catalog ⇒ falls back to a non-disabled additionalModelOptionsCache entry", () => {
    const dir = claudeDir();
    writeConfig(dir, loggedIn({ additionalModelOptionsCache: [{ value: `${MYTHOS_MODEL}[1m]` }] }));
    expect(available(dir)).toBe(true);
    writeConfig(
      dir,
      loggedIn({ additionalModelOptionsCache: [{ value: MYTHOS_MODEL, disabled: true }] }),
    );
    utimesSync(join(dir, ".claude.json"), new Date(), new Date(Date.now() + 5000));
    expect(available(dir)).toBe(false);
  });

  test("the newest same-org catalog wins", () => {
    const dir = claudeDir();
    writeConfig(dir, loggedIn());
    writeCatalog(dir, `${ORG}-aaaaaaaaaaaa-cc.json`, [MYTHOS_MODEL], 100);
    writeCatalog(dir, `${ORG}-bbbbbbbbbbbb-cc.json`, ["claude-opus-5-5"], 200);
    expect(available(dir)).toBe(false);
  });

  test("fails closed: missing files, malformed JSON, unknown version, no logged-in org", () => {
    expect(available(claudeDir())).toBe(false);

    const malformed = claudeDir();
    writeFileSync(join(malformed, ".claude.json"), "{not json");
    expect(available(malformed)).toBe(false);

    const newVersion = claudeDir();
    writeConfig(newVersion, loggedIn({ additionalModelOptionsCache: [] }));
    writeCatalog(newVersion, `${ORG}-ea9b5ce3c4f1-cc.json`, [MYTHOS_MODEL], 1, 3);
    expect(available(newVersion)).toBe(false);

    const loggedOut = claudeDir();
    writeConfig(loggedOut, { additionalModelOptionsCache: [{ value: MYTHOS_MODEL }] });
    expect(available(loggedOut)).toBe(false);
  });

  test("re-parses a file only after its mtime changes", () => {
    const dir = claudeDir();
    writeConfig(dir, loggedIn());
    const catalog = writeCatalog(dir, `${ORG}-ea9b5ce3c4f1-cc.json`, [MYTHOS_MODEL]);
    const reads: string[] = [];
    const models = createAccountModels(
      { home: "/nonexistent", claudeDir: dir },
      {
        readText: (path) => {
          reads.push(path);
          return readFileSync(path, "utf8");
        },
        mtimeMs: (path) => (existsSync(path) ? statSync(path).mtimeMs : null),
        list: (d) => (existsSync(d) ? readdirSync(d) : []),
      },
    );
    expect(models.mythosAvailable()).toBe(true);
    expect(models.mythosAvailable()).toBe(true);
    expect(reads.length).toBe(2); // .claude.json + the catalog, once each

    writeCatalog(dir, `${ORG}-ea9b5ce3c4f1-cc.json`, ["claude-opus-5-5"]);
    utimesSync(catalog, new Date(), new Date(Date.now() + 5000));
    expect(models.mythosAvailable()).toBe(false);
    expect(reads.length).toBe(3);
  });
});
