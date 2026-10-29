import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionStore } from "../src/store";
import { HeavySlotService } from "../src/heavy-slot";
import { EXIT_QUEUED, commandFrom, ingressConfig, main } from "../scripts/heavy-slot.mjs";
import type { Session } from "../src/types";

// The heavy-check runner (scripts/heavy-slot.mjs, #3181) as real subprocesses against a real
// HeavySlotService behind a local HTTP server: one check runs, the other is NOT run and told its
// place, the slot is handed over once the first one's processes are gone, and every failure path
// runs the command unmanaged. The commands are `touch`/`sleep` — no load.

const RUNNER = resolve(import.meta.dir, "..", "scripts", "heavy-slot.mjs");
const HEADER = "x-shepherd-ingress-key";
const dir = mkdtempSync(join(tmpdir(), "heavy-slot-runner-"));
const headerFile = join(dir, "s.header");
writeFileSync(headerFile, `${HEADER}: secret\n`);

let enabled = true;
const steers: [string, string][] = [];
let svc: HeavySlotService;
let server: ReturnType<typeof Bun.serve>;

function makeService(on: boolean): HeavySlotService {
  const store = new SessionStore(":memory:");
  const sessions = new Map(
    ["s1", "s2", "s3"].map((id) => [
      id,
      { id, status: "running", repoPath: "/repo", worktreePath: dir } as Session,
    ]),
  );
  return new HeavySlotService({
    store: {
      get: (id: string) => sessions.get(id) ?? null,
      listHeavySlotJobs: (s) => store.listHeavySlotJobs(s),
      upsertHeavySlotJob: (j) => store.upsertHeavySlotJob(j),
      heavySlotDurations: (k) => store.heavySlotDurations(k),
      pruneHeavySlotJobs: (b) => store.pruneHeavySlotJobs(b),
    } as ConstructorParameters<typeof HeavySlotService>[0]["store"],
    events: { emit: () => {} },
    steer: async (id, text) => {
      steers.push([id, text]);
      return true;
    },
    enabled: on,
    budget: { slots: 1, minAvailableBytes: 0, psiFullMax: 100, releaseHoldMs: 0 },
    sampleMemory: async () => ({ availableBytes: null, psiFullAvg10: null }),
  });
}

beforeAll(async () => {
  svc = makeService(true);
  await svc.start();
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const parts = new URL(req.url).pathname.split("/").filter(Boolean);
      if (req.headers.get(HEADER) !== "secret") return new Response("no", { status: 401 });
      const body = (await req.json()) as Record<string, unknown>;
      const id = parts[2]!;
      const slot = enabled ? svc : makeService(false);
      if (body.op === "acquire")
        return Response.json(
          await slot.acquire(id, String(body.command), String(body.cwd), body.canWait === true),
        );
      if (body.op === "finished")
        return Response.json({
          ok: await slot.finish(id, String(body.jobId), Number(body.exitCode)),
        });
      return Response.json({ ok: true });
    },
  });
});

afterAll(() => {
  svc.stop();
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

function runner(
  command: string | string[],
  session: string | null,
  url = `http://127.0.0.1:${server.port}`,
): Promise<{ code: number | null; stderr: string }> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  if (session) {
    env.SHEPHERD_AGENT_API_URL = url;
    env.SHEPHERD_SESSION_ID = session;
    env.SHEPHERD_INGRESS_HEADER_FILE = headerFile;
  }
  return new Promise((done) => {
    const args = typeof command === "string" ? ["--", command] : command;
    const child = spawn("node", [RUNNER, ...args], { cwd: dir, env });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code) => done({ code, stderr }));
  });
}

async function until(cond: () => boolean, ms = 5_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const f = (name: string) => join(dir, name);

describe("heavy-slot runner", () => {
  test("argv and ingress coordinates", () => {
    expect(commandFrom(["--", "bun run test"])).toBe("bun run test");
    expect(commandFrom(["bun"])).toBeNull();
    expect(
      ingressConfig(
        {
          SHEPHERD_AGENT_API_URL: "http://127.0.0.1:7331/",
          SHEPHERD_SESSION_ID: "abc",
          SHEPHERD_INGRESS_HEADER_FILE: "/h",
        },
        () => "x-shepherd-ingress-key: k1\n",
      ),
    ).toEqual({
      endpoint: "http://127.0.0.1:7331/api/sessions/abc/heavy-slot",
      header: ["x-shepherd-ingress-key", "k1"],
    });
    expect(ingressConfig({ SHEPHERD_SESSION_ID: "abc" })).toBeNull();
  });

  test.skipIf(process.platform !== "linux")(
    "one check runs, a concurrent one is NOT run and queued; the slot passes on once the first is gone",
    async () => {
      const first = runner(
        `echo "$SHEPHERD_HEAVY_JOB" > ${f("A.marker")}; touch ${f("A.started")}; sleep 1; exit 3`,
        "s1",
      );
      await until(() => existsSync(f("A.started")));

      const t0 = Date.now();
      const second = await runner(["--exec", "touch", f("B.ran")], "s2");
      expect(Date.now() - t0).toBeLessThan(2_000);
      expect(second.code).toBe(EXIT_QUEUED);
      expect(second.stderr).toContain("NOT RUN");
      expect(second.stderr).toContain("place 1 of 1");
      expect(existsSync(f("B.ran"))).toBe(false);

      const a = await first;
      expect(a.code).toBe(3); // the command's own exit code passes through
      expect(readFileSync(f("A.marker"), "utf8").trim()).toMatch(/^[0-9a-f-]{36}$/);
      await until(() => steers.some(([id]) => id === "s2"));

      const again = await runner(["--exec", "touch", f("B.ran")], "s2");
      expect(again.code).toBe(0);
      expect(existsSync(f("B.ran"))).toBe(true);
    },
  );

  test("unreachable server: runs unmanaged and says so", async () => {
    const out = await runner(`touch ${f("C.ran")}`, "s3", "http://127.0.0.1:9");
    expect(out.code).toBe(0);
    expect(out.stderr).toContain("heavy-check slot unavailable");
    expect(existsSync(f("C.ran"))).toBe(true);
  });

  test("disabled slot: runs unmanaged, silently", async () => {
    enabled = false;
    try {
      const out = await runner(`touch ${f("D.ran")}; exit 4`, "s3");
      expect(out.code).toBe(4);
      expect(out.stderr).toBe("");
      expect(existsSync(f("D.ran"))).toBe(true);
    } finally {
      enabled = true;
    }
  });

  test("outside a Shepherd session: runs the command directly", async () => {
    const out = await runner(`touch ${f("E.ran")}`, null);
    expect(out.code).toBe(0);
    expect(existsSync(f("E.ran"))).toBe(true);
  });
});

test("blocking runner starts after capacity increases without another agent turn", async () => {
  enabled = true;
  await svc.applyConfig({
    enabled: true,
    waitMinutes: 1,
    budget: { slots: 1, minAvailableBytes: 0, psiFullMax: 100, releaseHoldMs: 0 },
  });
  await svc.acquire("s1", "occupied", dir);
  const marker = join(dir, "blocked-then-ran");
  const pending = runner(`touch '${marker}'`, "s2");
  await new Promise((r) => setTimeout(r, 200));
  expect(existsSync(marker)).toBe(false);
  await svc.applyConfig({
    enabled: true,
    waitMinutes: 1,
    budget: { slots: 2, minAvailableBytes: 0, psiFullMax: 100, releaseHoldMs: 0 },
  });
  expect((await pending).code).toBe(0);
  expect(existsSync(marker)).toBe(true);
});

describe("runner execution boundaries", () => {
  test("Bash receives exactly one unchanged command", async () => {
    const command = `VALUE='a b'; printf '%s\\n' "$VALUE" | cat > '${f("shell-output")}'\nexit 6`;
    expect(commandFrom(["--", command])).toBe(command);
    const out = await runner(command, null);
    expect(out.code).toBe(6);
    expect(readFileSync(f("shell-output"), "utf8")).toBe("a b\n");
    expect(commandFrom(["--", "echo one", "echo two"])).toBeNull();
    expect((await runner(["--", "touch", f("must-not-run")], null)).code).toBe(2);
    expect(existsSync(f("must-not-run"))).toBe(false);
    expect(await main(["--", "echo\0bad"], {})).toBe(2);
    expect(await main(["--exec", "node", "bad\0argument"], {})).toBe(2);
  });

  test.each([null, "s3"])("direct argv is literal (session %s)", async (session) => {
    const suffix = session ?? "outside";
    const output = f(`argv-${suffix}.json`);
    const sideEffect = f(`injected-${suffix}`);
    const args = ["a b", "", "it's", `; touch '${sideEffect}'`, `$(touch '${sideEffect}')`, "--"];
    const script =
      "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ args: process.argv.slice(2), job: process.env.SHEPHERD_HEAVY_JOB }))";
    const out = await runner(["--exec", "node", "-e", script, output, ...args], session);
    expect(out.code).toBe(0);
    const result = JSON.parse(readFileSync(output, "utf8"));
    expect(result.args).toEqual(args);
    if (session) expect(result.job).toMatch(/^[0-9a-f-]{36}$/);
    else expect(result.job).toBeUndefined();
    expect(existsSync(sideEffect)).toBe(false);
  });

  test("direct spawn failures keep exit 127", async () => {
    expect((await runner(["--exec", "/no-such-heavy-slot-executable"], null)).code).toBe(127);
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
    const before = signals.map((signal) => process.listenerCount(signal));
    expect(await main(["--exec", "/no-such-heavy-slot-executable"], {})).toBe(127);
    expect(signals.map((signal) => process.listenerCount(signal))).toEqual(before);
    for (const args of [["--exec"], ["--exec", ""], ["--"], ["--", ""]]) {
      expect((await runner(args, null)).code).toBe(2);
    }
  });
});

const configEnv = {
  SHEPHERD_AGENT_API_URL: "http://127.0.0.1:7331",
  SHEPHERD_SESSION_ID: "s1",
  SHEPHERD_INGRESS_HEADER_FILE: "/h",
};

describe("local ingress boundary", () => {
  test.each(["127.0.0.1", "localhost", "[::1]", "10.0.2.2"])("accepts local host %s", (host) => {
    const cfg = ingressConfig(
      { ...configEnv, SHEPHERD_AGENT_API_URL: `http://${host}:7331/` },
      () => `${HEADER}: secret\n`,
    );
    expect(cfg?.endpoint).toBe(`http://${host}:7331/api/sessions/s1/heavy-slot`);
  });

  test.each([
    "http://example.com",
    "http://127.0.0.1.evil.example",
    "http://10.0.2.3",
    "file:///etc/passwd",
    "ftp://127.0.0.1",
    "not a URL",
    "http://user:password@127.0.0.1",
    "http://127.0.0.1/other",
    "http://127.0.0.1/?target=elsewhere",
    "http://127.0.0.1/#fragment",
  ])("rejects %s before reading the credential", (base) => {
    let reads = 0;
    expect(
      ingressConfig({ ...configEnv, SHEPHERD_AGENT_API_URL: base }, () => {
        reads++;
        return `${HEADER}: secret`;
      }),
    ).toBeNull();
    expect(reads).toBe(0);
  });

  test.each([
    "http://100.101.102.103:7330",
    "http://shepherd-container:7330",
    "https://shepherd.example.ts.net:8443",
    "http://shepherd-container",
    "https://shepherd.example.ts.net",
  ])("accepts the server-configured non-loopback origin %s", (origin) => {
    const cfg = ingressConfig(
      {
        ...configEnv,
        SHEPHERD_AGENT_API_URL: origin,
        SHEPHERD_AGENT_API_ORIGIN: origin,
      },
      () => `${HEADER}: secret`,
    );
    expect(cfg?.endpoint).toBe(`${origin}/api/sessions/s1/heavy-slot`);
    expect(
      ingressConfig({ ...configEnv, SHEPHERD_AGENT_API_URL: origin }, () => `${HEADER}: secret`),
    ).toBeNull();
  });

  test.each([
    "http://foreign.example:7330",
    "http://shepherd-container.evil.example:7330",
    "http://shepherd-container:7331",
    "https://shepherd-container:7330",
    "http://shepherd-container:0",
    "http://shepherd-container:65536",
    "ftp://shepherd-container:7330",
    "http://127.0.0.1:0",
  ])("rejects unapproved origin or invalid port %s before reading credentials", (base) => {
    let reads = 0;
    expect(
      ingressConfig(
        {
          ...configEnv,
          SHEPHERD_AGENT_API_URL: base,
          SHEPHERD_AGENT_API_ORIGIN: "http://shepherd-container:7330",
        },
        () => {
          reads++;
          return `${HEADER}: secret`;
        },
      ),
    ).toBeNull();
    expect(reads).toBe(0);
  });

  test("a configured non-loopback origin still permits loopback", () => {
    expect(
      ingressConfig(
        {
          ...configEnv,
          SHEPHERD_AGENT_API_ORIGIN: "http://shepherd-container:7330",
        },
        () => `${HEADER}: secret`,
      )?.endpoint,
    ).toBe("http://127.0.0.1:7331/api/sessions/s1/heavy-slot");
  });

  test("session ids remain a single encoded path segment", () => {
    for (const id of [".", "..", "bad\0id", ""]) {
      expect(
        ingressConfig({ ...configEnv, SHEPHERD_SESSION_ID: id }, () => `${HEADER}: secret`),
      ).toBeNull();
    }
    expect(
      ingressConfig({ ...configEnv, SHEPHERD_SESSION_ID: "a/b?c#d" }, () => `${HEADER}: secret`)
        ?.endpoint,
    ).toBe("http://127.0.0.1:7331/api/sessions/a%2Fb%3Fc%23d/heavy-slot");
  });

  test.each([
    "bad name: secret",
    `${HEADER}: secret\r\nx-other: leak`,
    `${HEADER}: secret\0`,
    `${HEADER}: secret\n\n`,
  ])("rejects malformed header %j", (line) => {
    expect(ingressConfig(configEnv, () => line)).toBeNull();
  });

  test("invalid ingress config runs unmanaged without making a request", async () => {
    let requests = 0;
    const local = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        requests++;
        return Response.json({});
      },
    });
    try {
      const out = await runner(
        `touch '${f("invalid-config-ran")}'`,
        "s3",
        `http://127.0.0.1:${local.port}/wrong`,
      );
      expect(out.code).toBe(0);
      expect(existsSync(f("invalid-config-ran"))).toBe(true);
      expect(requests).toBe(0);
    } finally {
      local.stop(true);
    }
  });

  test("redirects never forward header-file credentials", async () => {
    let requests = 0,
      redirects = 0;
    const receiver = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        requests++;
        return Response.json({});
      },
    });
    const redirector = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        expect(req.headers.get(HEADER)).toBe("secret");
        redirects++;
        return Response.redirect(`http://127.0.0.1:${receiver.port}/leak`, 307);
      },
    });
    try {
      const out = await runner(
        `touch '${f("redirect-fallback")}'`,
        "s3",
        `http://127.0.0.1:${redirector.port}`,
      );
      expect(out.code).toBe(0);
      expect(out.stderr).toContain("heavy-check slot unavailable");
      expect(existsSync(f("redirect-fallback"))).toBe(true);
      expect(redirects).toBe(1);
      expect(requests).toBe(0);
    } finally {
      redirector.stop(true);
      receiver.stop(true);
    }
  });
});

test.each(["bash", "direct"])("forwards signals to the child (%s)", async (mode) => {
  const ready = f(`signal-${mode}`);
  const script = f(`signal-${mode}.cjs`);
  writeFileSync(
    script,
    `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); process.on('SIGTERM', () => process.exit(42)); setInterval(() => {}, 1000);`,
  );
  const args = mode === "bash" ? ["--", `exec node '${script}'`] : ["--exec", "node", script];
  const child = spawn("node", [RUNNER, ...args], {
    env: { PATH: process.env.PATH },
    stdio: "ignore",
  });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  try {
    await until(() => existsSync(ready));
    child.kill("SIGTERM");
    expect(await exited).toBe(42);
  } finally {
    child.kill("SIGKILL");
  }
});

test("a queued direct command supplies shell-quoted rerun instructions without starting it", async () => {
  const slot = makeService(true);
  await slot.start();
  await slot.acquire("s1", "occupied", dir);
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = await req.json();
      return Response.json(await slot.acquire("s2", body.command, dir));
    },
  });
  const output = f("rerun-argv.json");
  const injected = f("rerun-injected");
  const args = ["a b", "", "it's", `$(touch '${injected}')`, ";"];
  try {
    const queued = await runner(
      [
        "--exec",
        "node",
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))",
        output,
        ...args,
      ],
      "s2",
      `http://127.0.0.1:${api.port}`,
    );
    expect(queued.code).toBe(EXIT_QUEUED);
    expect(existsSync(output)).toBe(false);
    const rerun = queued.stderr.match(/NOT RUN\. `([^`]+)`/)?.[1];
    expect(rerun).toBeDefined();
    expect((await runner(rerun!, null)).code).toBe(0);
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(args);
    expect(existsSync(injected)).toBe(false);
  } finally {
    api.stop(true);
    slot.stop();
  }
});
