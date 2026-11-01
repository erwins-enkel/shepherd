// `ctx.forge.security`: typed refusals, secret masking and pass-through of listings.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePluginForgeSecurity } from "../src/plugins/forge-security";
import type { ForgeCodeScanningAlert, GitForge } from "../src/forge/types";

let root: string;
let repo: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "shepherd-plugin-forge-security-"));
  repo = join(root, "repo");
  await mkdir(repo);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const ALERT: ForgeCodeScanningAlert = {
  number: 1,
  url: "https://x/1",
  ruleId: "r",
  ruleDescription: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  securitySeverity: "high",
  tool: "CodeQL",
  cwes: [],
  path: "a.ts",
  line: 1,
  message: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  classifications: [],
  createdAt: 0,
};

const security = (forge: GitForge | null) =>
  makePluginForgeSecurity({ repoRoot: root, resolveForge: () => forge });

test("masks secret-shaped text in listed alerts", async () => {
  const forge = {
    listCodeScanningAlerts: async () => ({ status: "ok", alerts: [ALERT], truncated: true }),
  } as unknown as GitForge;
  const res = await security(forge).listCodeScanningAlerts(repo);
  if (res.status !== "ok") throw new Error("expected ok");
  expect(res.truncated).toBe(true);
  expect(res.alerts[0]?.message).not.toContain("ghp_abc");
  expect(res.alerts[0]?.ruleDescription).not.toContain("ghp_abc");
});

test("passes an unavailable listing through; forge failures propagate", async () => {
  const forge = {
    listDependabotAlerts: async () => ({ status: "unavailable", reason: "disabled" }),
    listCodeScanningAlerts: async () => {
      throw new Error("HTTP 500");
    },
  } as unknown as GitForge;
  expect(await security(forge).listDependabotAlerts(repo)).toEqual({
    status: "unavailable",
    reason: "disabled",
  });
  await expect(security(forge).listCodeScanningAlerts(repo)).rejects.toThrow("HTTP 500");
});

test("typed refusals: invalid repo, no forge, unsupported host, lightweight", async () => {
  const refusal = async (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: { name: string; code: string }) => `${e.name}:${e.code}`,
    );
  expect(await refusal(security({} as GitForge).visibility("/nope"))).toBe(
    "PluginForgeError:invalid-repo",
  );
  expect(await refusal(security(null).visibility(repo))).toBe("PluginForgeError:no-forge");
  expect(await refusal(security({} as GitForge).visibility(repo))).toBe(
    "PluginForgeError:unsupported",
  );
  expect(
    await refusal(security({ isLightweight: true } as unknown as GitForge).visibility(repo)),
  ).toBe("PluginForgeError:lightweight");
  expect(await refusal(makePluginForgeSecurity(undefined).visibility(repo))).toBe(
    "PluginForgeError:no-forge",
  );
});
