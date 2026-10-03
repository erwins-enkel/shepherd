import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

describe("native iOS acceptance tools", () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "ios-gates-"));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const python = (script: string, ...args: string[]) =>
    Bun.spawnSync(["python3", resolve("native/scripts", script), ...args]);
  function json(name: string, value: unknown) {
    const path = join(directory, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  }
  for (const kind of ["pass", "zero", "skip", "malformed"]) {
    test(`result inventory ${kind}`, () => {
      const fixture = JSON.parse(
        readFileSync(`test/fixtures/native-ios-stage2-results-${kind}.json`, "utf8"),
      );
      const result = python(
        "check-ios-results.py",
        json("summary.json", fixture.summary),
        json("tests.json", fixture.tests),
        "--expected",
        json("expected.json", fixture.expected),
      );
      expect(result.exitCode === 0).toBe(kind === "pass");
    });
  }
  for (const resultState of ["Passed", "Failed", "Skipped"]) {
    test(`UI test bundle preserves ${resultState} case results`, () => {
      const fixture = JSON.parse(
        readFileSync("test/fixtures/native-ios-stage2-results-pass.json", "utf8"),
      );
      fixture.tests.testNodes[0].result = resultState;
      const tests = {
        testNodes: [
          {
            nodeType: "Test Plan",
            result: "Passed",
            children: [
              { nodeType: "UI test bundle", result: "Passed", children: fixture.tests.testNodes },
            ],
          },
        ],
      };
      const result = python(
        "check-ios-results.py",
        json("summary.json", fixture.summary),
        json("tests.json", tests),
        "--expected",
        json("expected.json", fixture.expected),
      );
      expect(result.exitCode === 0).toBe(resultState === "Passed");
    });
  }
  test("rejects passing counts when a required identity never executed", () => {
    const fixture = JSON.parse(
      readFileSync("test/fixtures/native-ios-stage2-results-pass.json", "utf8"),
    );
    const result = python(
      "check-ios-results.py",
      json("summary.json", fixture.summary),
      json("tests.json", fixture.tests),
      "--expected",
      json("expected.json", [...fixture.expected, "Missing/testMissing"]),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("identity");
  });
  for (const family of ["iPhone", "iPad"]) {
    test(`selects newest available ${family} without crossing families`, () => {
      const devices = {
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-18-9": [
            { name: `${family} Old`, udid: "OLD", isAvailable: true },
          ],
          "com.apple.CoreSimulator.SimRuntime.iOS-18-10": [
            { name: "iPhone 17", udid: "PHONE", isAvailable: true },
            { name: "iPad Pro (12.9-inch)", udid: "PAD", isAvailable: true },
            { name: `${family} Unavailable`, udid: "BAD", isAvailable: false },
          ],
        },
      };
      const result = python(
        "select-ios-simulator.py",
        json("devices.json", devices),
        "--family",
        family,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString().trim()).toBe(family === "iPhone" ? "PHONE" : "PAD");
    });
  }
  test("does not substitute ordinary iPhones for unavailable Duo hardware", () => {
    const path = json("devices.json", {
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-27-1": [
          { name: "iPhone 17", udid: "PHONE", isAvailable: true },
        ],
      },
    });
    const result = python("select-ios-simulator.py", path, "--family", "DuoInner");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe("");
  });
  test("ui/messages-only PRs don't start the iOS workflow; contract and native edits still do", () => {
    const workflow = Bun.YAML.parse(readFileSync(".github/workflows/native-ios.yml", "utf8")) as {
      on: Record<"pull_request" | "push", { paths: string[] }>;
      jobs: { ios: { steps: { run?: string }[] } };
    };
    // #2709: the Linux `static` lane owns the catalog check on every PR.
    for (const event of ["pull_request", "push"] as const) {
      expect(workflow.on[event].paths).not.toContain("ui/messages/*.json");
      expect(workflow.on[event].paths).toContain("native/**");
      expect(workflow.on[event].paths).toContain("contracts/**");
    }
    expect(
      workflow.jobs.ios.steps.some((step) => step.run?.includes("bun run check:strings")),
    ).toBe(true);
  });
  test("rejects unsigned release export inputs before invoking Xcode", () => {
    const result = Bun.spawnSync(
      ["bash", resolve("native/scripts/archive-ios-app.sh"), "Release"],
      { env: { PATH: process.env.PATH!, HOME: directory } },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("UNMET:");
  });
  test("rejects automatic signing, unrelated profiles and upload destinations before invoking Xcode", () => {
    for (const invalid of ["automatic", "wrong-profile", "upload"]) {
      const options = join(directory, `${invalid}.plist`);
      const fixture = Bun.spawnSync([
        "python3",
        "-c",
        "import plistlib, sys; plistlib.dump(dict(method='app-store-connect', destination='upload' if sys.argv[2]=='upload' else 'export', teamID='TEAM', signingStyle='automatic' if sys.argv[2]=='automatic' else 'manual', signingCertificate='Apple Distribution', provisioningProfiles={'run.shepherd.ios': 'OTHER' if sys.argv[2]=='wrong-profile' else 'PROFILE'}, manageAppVersionAndBuildNumber=False), open(sys.argv[1], 'wb'))",
        options,
        invalid,
      ]);
      expect(fixture.exitCode).toBe(0);
      const result = Bun.spawnSync(
        ["bash", resolve("native/scripts/archive-ios-app.sh"), "Release"],
        {
          env: {
            PATH: process.env.PATH!,
            HOME: directory,
            GITHUB_ACTIONS: "true",
            RUNNER_OS: "macOS",
            APPLE_TEAM_ID: "TEAM",
            SHEPHERD_IOS_PROFILE_UUID: "PROFILE",
            SHEPHERD_IOS_EXPORT_OPTIONS: options,
            SHEPHERD_IOS_BUILD_NUMBER: "1",
            SHEPHERD_IOS_VERSION: "0.1.0",
          },
        },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain(
        "export options disagree with manual signing policy",
      );
    }
  });
  test("cleanup verifier rejects a handoff owned by another run without revealing credentials", () => {
    const handoff = json("token.json", {
      runID: "another-run",
      tokenID: "owned-id",
      token: "DO-NOT-PRINT",
      baseURL: "http://127.0.0.1:1",
    });
    chmodSync(handoff, 0o600);
    const result = python(
      "verify-ios-live-cleanup.py",
      "--handoff",
      handoff,
      "--status",
      join(directory, "proof.json"),
      "--run-id",
      "our-run",
      "--server-url",
      "http://127.0.0.1:1",
      "--revoke",
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("UNMET: cleanup ownership");
    expect(result.stderr.toString()).not.toContain("DO-NOT-PRINT");
  });
  test("cleanup verifier requires a real HTTP 401 after revoking the exact token", async () => {
    const requests: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        requests.push(
          `${request.method} ${new URL(request.url).pathname} ${request.headers.get("authorization")}`,
        );
        return new Response(null, { status: request.method === "DELETE" ? 204 : 401 });
      },
    });
    try {
      const handoff = json("token.json", {
        runID: "our-run",
        tokenID: "owned-id",
        token: "fixture-token",
        baseURL: server.url.origin,
      });
      chmodSync(handoff, 0o600);
      const result = Bun.spawn([
        "python3",
        resolve("native/scripts/verify-ios-live-cleanup.py"),
        "--handoff",
        handoff,
        "--status",
        join(directory, "proof.json"),
        "--run-id",
        "our-run",
        "--server-url",
        server.url.origin,
        "--revoke",
      ]);
      expect(await result.exited).toBe(0);
      expect(requests).toEqual([
        "DELETE /api/access-tokens/owned-id Bearer fixture-token",
        "GET /api/sessions Bearer fixture-token",
      ]);
      expect(
        JSON.parse(readFileSync(join(directory, "proof.json"), "utf8")).verifiedHTTPStatus,
      ).toBe(401);
    } finally {
      server.stop(true);
    }
  });
  test("refused revocation and still-authorized token cannot produce cleanup proof", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        return new Response(null, { status: request.method === "DELETE" ? 403 : 200 });
      },
    });
    try {
      const handoff = json("token.json", {
        runID: "our-run",
        tokenID: "owned-id",
        token: "NEVER-LOG-THIS",
        baseURL: server.url.origin,
      });
      chmodSync(handoff, 0o600);
      const child = Bun.spawn(
        [
          "python3",
          resolve("native/scripts/verify-ios-live-cleanup.py"),
          "--handoff",
          handoff,
          "--status",
          join(directory, "proof.json"),
          "--run-id",
          "our-run",
          "--server-url",
          server.url.origin,
          "--revoke",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(await child.exited).not.toBe(0);
      const error = await new Response(child.stderr).text();
      expect(error).toContain("lacks HTTP-401 proof");
      expect(error).not.toContain("NEVER-LOG-THIS");
      expect(readFileSync(handoff, "utf8")).toContain("NEVER-LOG-THIS");
    } finally {
      server.stop(true);
    }
  });
});
