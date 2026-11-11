import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEgressConfig,
  buildEgressReloadNft,
  readEgressSpawnInputs,
  requestEgressReload,
  writeEgressReloadFiles,
  writeEgressSpawnInputs,
} from "../src/egress";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "egress-reload-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const noSleep = () => Promise.resolve();

describe("buildEgressReloadNft", () => {
  const cfg = buildEgressConfig(["registry.npmjs.org", "corp.example.com:8443"], { tmpDir: "/t" });

  test("additive reload empties the chains and re-declares the full ruleset", () => {
    const out = buildEgressReloadNft(cfg, { flushPinned: false });
    expect(out).toContain("flush chain inet egress out\n");
    expect(out).toContain("flush chain ip devfwd pre\n");
    expect(out).not.toContain("delete table");
    expect(out.endsWith(cfg.nftRuleset)).toBe(true);
    expect(out).toContain("set allowed_p8443");
  });

  test("flushPinned drops both tables before re-declaring", () => {
    const out = buildEgressReloadNft(cfg, { flushPinned: true });
    expect(out.startsWith("delete table inet egress\ndelete table ip devfwd\n")).toBe(true);
    expect(out).not.toContain("flush chain");
    expect(out.endsWith(cfg.nftRuleset)).toBe(true);
  });
});

describe("writeEgressReloadFiles", () => {
  test("writes the reload script, argv and ruleset", async () => {
    const d = tmp();
    const cfg = buildEgressConfig(["a.example.com"], { tmpDir: d });
    await writeEgressReloadFiles(d, cfg, "RELOAD");
    expect(readFileSync(join(d, "egress.reload.nft"), "utf8")).toBe("RELOAD");
    expect(readFileSync(join(d, "dnsmasq.argv"), "utf8")).toBe(cfg.dnsmasqArgv.join("\n"));
    expect(readFileSync(join(d, "egress.nft"), "utf8")).toBe(cfg.nftRuleset);
  });
});

describe("requestEgressReload", () => {
  test("no FIFO → unsupported", async () => {
    expect(await requestEgressReload(tmp(), { sleep: noSleep })).toBe("unsupported");
  });

  test("FIFO without a reader → unsupported (never blocks)", async () => {
    const d = tmp();
    expect(spawnSync("mkfifo", [join(d, "reload.fifo")]).status).toBe(0);
    expect(await requestEgressReload(d, { sleep: noSleep })).toBe("unsupported");
  });

  function fakeRunner(result: string | null) {
    let sent = "";
    return {
      signal: async (_fifo: string, line: string) => {
        sent = line.trim();
      },
      readStatus: async () => (result === null ? null : `${sent} ${result}\n`),
      sleep: noSleep,
      timeoutMs: 500,
    };
  }

  test("status ok for our seq → applied", async () => {
    expect(await requestEgressReload("/t", fakeRunner("ok"))).toBe("applied");
  });

  test("status fail for our seq → failed", async () => {
    expect(await requestEgressReload("/t", fakeRunner("fail"))).toBe("failed");
  });

  test("silence or a stale seq → timeout", async () => {
    expect(await requestEgressReload("/t", fakeRunner(null))).toBe("timeout");
    expect(
      await requestEgressReload("/t", {
        signal: async () => {},
        readStatus: async () => "old-seq ok",
        sleep: noSleep,
        timeoutMs: 300,
      }),
    ).toBe("timeout");
  });

  test("real FIFO with a reader round-trips", async () => {
    const d = tmp();
    const fifo = join(d, "reload.fifo");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    // A one-shot shell "runner": read a seq, report it ok.
    const runner = Bun.spawn([
      "bash",
      "-c",
      `read -r SEQ < "${fifo}"; echo "$SEQ ok" > "${join(d, "reload.status")}"`,
    ]);
    // Give the reader a moment to open the FIFO.
    let out = "unsupported";
    for (let i = 0; i < 50 && out === "unsupported"; i++) {
      out = await requestEgressReload(d, { timeoutMs: 2_000 });
      if (out === "unsupported") await Bun.sleep(20);
    }
    expect(out).toBe("applied");
    await runner.exited;
  });
});

describe("egress spawn inputs", () => {
  test("round-trips", async () => {
    const d = tmp();
    const inputs = {
      repoPath: "/r",
      hostGateway: { ip: "10.0.2.2", port: 7331 },
      connectorHosts: ["mcp-proxy.anthropic.com"],
      allowlist: ["a.example.com"],
    };
    writeEgressSpawnInputs(d, inputs);
    expect(await readEgressSpawnInputs(d)).toEqual(inputs);
  });

  test("absent or malformed → null", async () => {
    const d = tmp();
    expect(await readEgressSpawnInputs(d)).toBeNull();
    writeFileSync(join(d, "egress-spawn.json"), "{not json");
    expect(await readEgressSpawnInputs(d)).toBeNull();
    writeFileSync(join(d, "egress-spawn.json"), JSON.stringify({ repoPath: "/r", allowlist: [1] }));
    expect(await readEgressSpawnInputs(d)).toBeNull();
  });
});
