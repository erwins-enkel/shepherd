import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Executable harness: the REAL deploy/update.sh with stub git/bun on PATH and a temporary HOME, so
// nothing touches the host. Asserts the line the server later takes over (#3623).

const SCRIPT = join(import.meta.dir, "..", "deploy", "update.sh");
const REQUEST_ID = "11111111-2222-4333-8444-555555555555";
const SESSION_ID = "66666666-7777-4888-8999-000000000000";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

/** `git pull` moves the stub's HEAD, so `from` and `to` can only match the real sequence. */
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "shepherd-journal-"));
  dirs.push(home);
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "git"),
    `#!/usr/bin/env bash
head="${home}/head"
[ -f "$head" ] || echo aaaaaaa > "$head"
case "$1" in
  pull) echo bbbbbbb > "$head" ;;
  rev-parse)
    if [ "$2" = "--abbrev-ref" ]; then echo main; else cat "$head"; fi ;;
esac
exit 0
`,
  );
  writeFileSync(join(bin, "bun"), "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(join(bin, "uname"), '#!/usr/bin/env bash\necho "${STUB_UNAME:-Linux}"\n');
  for (const tool of ["git", "bun", "uname"]) chmodSync(join(bin, tool), 0o755);
  return home;
}

function run(home: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: `${join(home, "bin")}:${process.env.PATH}`,
      HOME: home,
      SHEPHERD_NO_CLI: "1",
      SHEPHERD_NO_SERVICE: "0",
      ...env,
    },
  });
}

const journalOf = (home: string) =>
  readFileSync(join(home, ".shepherd", "update-journal.jsonl"), "utf8")
    .trim()
    .split("\n");

test("a --pull run journals the commit it moved to, unattributed to any session", () => {
  const home = makeHome();
  expect(run(home, ["--pull"]).status).toBe(0);
  const [line, ...rest] = journalOf(home);
  expect(rest).toEqual([]);
  const entry = JSON.parse(line!);
  expect(entry).toMatchObject({
    from: "aaaaaaa",
    to: "bbbbbbb",
    pull: true,
    tty: false,
    app: false,
  });
  expect(entry.at).toBeGreaterThan(1_000_000_000_000);
  expect(entry).not.toContainKeys(["requestId", "sessionId"]);
  expect(statSync(join(home, ".shepherd", "update-journal.jsonl")).mode & 0o077).toBe(0);
});

test("a run without --pull still journals: it restarts the service too", () => {
  const home = makeHome();
  expect(run(home, []).status).toBe(0);
  expect(JSON.parse(journalOf(home)[0]!)).toMatchObject({
    from: "aaaaaaa",
    to: "aaaaaaa",
    pull: false,
  });
});

test("the request id and the session marker land in the line", () => {
  const home = makeHome();
  const res = run(home, ["--pull"], {
    SHEPHERD_UPDATE_REQUEST_ID: REQUEST_ID,
    SHEPHERD_SESSION_ID: SESSION_ID,
  });
  expect(res.status).toBe(0);
  expect(JSON.parse(journalOf(home)[0]!)).toMatchObject({
    requestId: REQUEST_ID,
    sessionId: SESSION_ID,
    app: false,
  });
});

test("only a sessionless no-service run on a Mac reads as the app", () => {
  const appFlag = (env: Record<string, string>) => {
    const home = makeHome();
    expect(run(home, [], env).status).toBe(0);
    return JSON.parse(journalOf(home)[0]!).app;
  };
  const mac = { STUB_UNAME: "Darwin", SHEPHERD_NO_SERVICE: "1" };
  expect(appFlag(mac)).toBe(true);
  // The general skip-systemd knob on Linux, and an agent's own run on a Mac, stay script runs.
  expect(appFlag({ SHEPHERD_NO_SERVICE: "1" })).toBe(false);
  expect(appFlag({ ...mac, SHEPHERD_SESSION_ID: SESSION_ID })).toBe(false);
  expect(appFlag({ STUB_UNAME: "Darwin" })).toBe(false);
});

test("a marker that is no UUID cannot inject into the JSON line", () => {
  const home = makeHome();
  const res = run(home, ["--pull"], {
    SHEPHERD_SESSION_ID: 'x","to":"evil',
    SHEPHERD_UPDATE_REQUEST_ID: "not-a-uuid",
  });
  expect(res.status).toBe(0);
  const entry = JSON.parse(journalOf(home)[0]!);
  expect(entry.to).toBe("bbbbbbb");
  expect(entry).not.toContainKeys(["requestId", "sessionId"]);
});

test("the journal follows SHEPHERD_DB from the env file, like the server's path", () => {
  const home = makeHome();
  mkdirSync(join(home, ".shepherd"));
  writeFileSync(join(home, ".shepherd", "env"), `SHEPHERD_DB=${home}/elsewhere/shepherd.db\n`);
  expect(run(home, []).status).toBe(0);
  expect(existsSync(join(home, "elsewhere", "update-journal.jsonl"))).toBe(true);
  expect(existsSync(join(home, ".shepherd", "update-journal.jsonl"))).toBe(false);
});

test("an unwritable journal warns and never fails the deploy", () => {
  const home = makeHome();
  mkdirSync(join(home, ".shepherd"));
  mkdirSync(join(home, ".shepherd", "update-journal.jsonl")); // a directory cannot be appended to
  const res = run(home, ["--pull"]);
  expect(res.status).toBe(0);
  expect(res.stdout).toContain("could not write the update journal");
});
