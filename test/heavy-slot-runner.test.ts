import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionStore } from "../src/store";
import { HeavySlotService } from "../src/heavy-slot";
import { EXIT_QUEUED, commandFrom, ingressConfig } from "../scripts/heavy-slot.mjs";
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
  command: string,
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
    const child = spawn("node", [RUNNER, "--", command], { cwd: dir, env });
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
      const second = await runner(`touch ${f("B.ran")}`, "s2");
      expect(Date.now() - t0).toBeLessThan(2_000);
      expect(second.code).toBe(EXIT_QUEUED);
      expect(second.stderr).toContain("NOT RUN");
      expect(second.stderr).toContain("place 1 of 1");
      expect(existsSync(f("B.ran"))).toBe(false);

      const a = await first;
      expect(a.code).toBe(3); // the command's own exit code passes through
      expect(readFileSync(f("A.marker"), "utf8").trim()).toMatch(/^[0-9a-f-]{36}$/);
      await until(() => steers.some(([id]) => id === "s2"));

      const again = await runner(`touch ${f("B.ran")}`, "s2");
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
