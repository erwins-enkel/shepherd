import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  identity,
  readFixtureProvenance,
  verifyConservation,
  verifyFixtureTransitions,
  type FixtureTransition,
  type IdentityMap,
  type TestIdentity,
} from "../native/scripts/test-conservation";

const dir = new URL("../native/Tests/Conservation/", import.meta.url);
const baseline = JSON.parse(readFileSync(new URL("issue-2431-baseline.json", dir), "utf8"))
  .tests as TestIdentity[];
const map = JSON.parse(readFileSync(new URL("issue-2431-map.json", dir), "utf8")) as {
  mappings: IdentityMap[];
  added: string[];
  upstreamAdded: string[];
  harnessAdded: string[];
};
const { provenance, source, reviewed } = readFixtureProvenance(
  new URL("../", import.meta.url).pathname,
);
const transitions = provenance.transitions;
const originals = baseline.filter((t) => transitions.some((x) => x.oldID === identity(t)));
const rows = map.mappings.filter((t) => transitions.some((x) => x.oldID === t.oldID));
const destinations = transitions.map((t) => t.destination);
function verify(current = destinations, changes = transitions, pinned = reviewed) {
  return verifyFixtureTransitions(originals, source, pinned, current, rows, changes);
}

describe("native fixture conservation", () => {
  test("exact Git-anchored adaptations retain both original tests and the one token-source substitution", () => {
    const effective = verify();
    verifyConservation(effective, destinations, rows, []);
    expect(originals).toHaveLength(2);
    expect(map.added).toHaveLength(8);
    expect(map.upstreamAdded).toHaveLength(54);
    expect(map.harnessAdded).toHaveLength(7);
  });
  for (const [index, transition] of transitions.entries()) {
    test(`rejects an original assertion deletion from ${transition.destination.signature}`, () => {
      const changed = {
        ...transition.destination,
        assertionHashes: transition.destination.assertionHashes!.slice(0, -1),
        assertionConditionHashes: transition.destination.assertionConditionHashes!.slice(0, -1),
      };
      const current = destinations.map((t, i) => (i === index ? changed : t));
      expect(() => verify(current)).toThrow();
      // Even a rewritten destination manifest/reviewed snapshot cannot authorize assertion loss.
      const altered = transitions.map((t, i) => (i === index ? { ...t, destination: changed } : t));
      expect(() => verify(current, altered, current)).toThrow("original assertion");
    });
  }
  test("rejects destination body drift, wrong Git provenance, and an explanatory-string bypass", () => {
    expect(() => verify(destinations.map((t) => ({ ...t, bodyHash: "drift" })))).toThrow("drift");
    const altered = transitions.map((t) => ({
      ...t,
      source: { ...t.source, bodyHash: "recaptured" },
    }));
    expect(() => verify(destinations, altered)).toThrow("Git");
    expect(() =>
      verifyFixtureTransitions(
        originals,
        source,
        reviewed,
        destinations,
        rows.map((t) => ({ ...t, assertionChanges: ["fixture: please allow arbitrary changes"] })),
        transitions,
      ),
    ).toThrow();
  });
  test("rejects unlisted assertion substitutions and changed assertion conditions", () => {
    for (const field of ["assertionHashes", "assertionConditionHashes"] as const) {
      const current = destinations.map((t) => ({
        ...t,
        [field]: ["unlisted", ...t[field]!.slice(1)],
      }));
      const altered: FixtureTransition[] = transitions.map((t, i) => ({
        ...t,
        destination: current[i]!,
      }));
      expect(() => verify(current, altered, current)).toThrow("original assertion");
    }
  });
  test("rejects omitted transitions, destination remaps, and weakened traits", () => {
    expect(() => verify(destinations, transitions.slice(1))).toThrow();
    expect(() =>
      verifyFixtureTransitions(
        originals,
        source,
        reviewed,
        destinations,
        rows.map((t) => ({ ...t, destinations: ["unlisted"] })),
        transitions,
      ),
    ).toThrow();
    const current = destinations.map((t) => ({ ...t, attributes: "@Test" }));
    expect(() =>
      verify(
        current,
        transitions.map((t, i) => ({ ...t, destination: current[i]! })),
        current,
      ),
    ).toThrow("attributes");
  });
  test("snapshot content and manifest recapture cannot replace the reviewed bytes", () => {
    const scratch = mkdtempSync(join(tmpdir(), "shepherd-fixture-pins-"));
    try {
      const destination = join(scratch, "native/Tests/Conservation");
      cpSync(dir, destination, { recursive: true });
      const snapshot = join(destination, provenance.snapshots.reviewed.file);
      const changed = readFileSync(snapshot, "utf8").replace(
        "#require(fixtureToken)",
        "#require(unlistedToken)",
      );
      writeFileSync(snapshot, changed);
      expect(() => readFixtureProvenance(scratch)).toThrow("snapshot content changed");
      const recaptured = structuredClone(provenance);
      recaptured.snapshots.reviewed.sha256 = createHash("sha256").update(changed).digest("hex");
      writeFileSync(join(destination, "issue-2431-fixtures.json"), JSON.stringify(recaptured));
      expect(() => readFixtureProvenance(scratch)).toThrow("snapshot pin changed");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("fresh clone after squash runs the checker without feature commits and rejects source mutations", () => {
    const scratch = mkdtempSync(join(tmpdir(), "shepherd-fixture-squash-"));
    const root = new URL("../", import.meta.url).pathname;
    const remote = join(scratch, "main-history");
    const clone = join(scratch, "fresh-clone");
    const originalSHA = "83e8d45172fc63eff1336c12cf6d850cdbfdfcb8";
    const upstreamSHA = "c4961c40ec2cdfde9c011387536d2bd0bc1f9e58";
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.invalid",
          GIT_COMMITTER_NAME: "Fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        },
      }).trim();
    try {
      mkdirSync(remote);
      git(remote, "init", "--quiet");
      // Local file transport only. Transfer durable main anchors, never feature objects.
      // Shallow anchors keep the fixture bounded while preserving their exact real hashes.
      git(
        remote,
        "-c",
        "protocol.file.allow=always",
        "fetch",
        "--quiet",
        "--depth=1",
        `file://${root}`,
        originalSHA,
        upstreamSHA,
      );
      git(remote, "tag", "original-main", originalSHA);
      git(remote, "checkout", "--quiet", "-b", "main", upstreamSHA);
      const paths = [
        "native/Apps/ShepherdMac/Tests",
        "native/Apps/ShepherdMac/UITests",
        "native/Tests/ShepherdKitTests",
        "native/Tests/ShepherdAppCoreTests",
        "native/Tests/Conservation",
        "native/scripts/test-conservation.ts",
        "test/native-fixture-conservation.test.ts",
      ];
      for (const path of paths) {
        rmSync(join(remote, path), { recursive: true, force: true });
        mkdirSync(join(remote, path, ".."), { recursive: true });
        cpSync(join(root, path), join(remote, path), { recursive: true });
      }
      git(remote, "add", "--", ...paths);
      git(
        remote,
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--quiet",
        "-m",
        "Squashed fixture adaptation",
      );
      git(
        scratch,
        "-c",
        "protocol.file.allow=always",
        "clone",
        "--quiet",
        "--no-local",
        remote,
        clone,
      );
      expect(git(clone, "rev-list", "--all").split("\n")).toContain(originalSHA);
      expect(git(clone, "merge-base", upstreamSHA, "HEAD")).toBe(upstreamSHA);
      for (const sha of [provenance.sourceSHA, provenance.reviewedSHA]) {
        expect(
          spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: clone }).status,
        ).not.toBe(0);
      }
      const check = () =>
        spawnSync(process.execPath, ["run", "native/scripts/test-conservation.ts", "--check"], {
          cwd: clone,
          encoding: "utf8",
        });
      const legitimate = check();
      expect(legitimate.stderr).toBe("");
      expect(legitimate.status).toBe(0);
      expect(legitimate.stdout).toContain("conserved original identities=1519");
      // Import and execute the existing negative test suite in the fresh checkout too.
      // Select the unit cases explicitly to avoid recursively running this integration case.
      const runner = join(scratch, "test-wrapper");
      mkdirSync(runner);
      writeFileSync(
        join(runner, "package.json"),
        JSON.stringify({
          scripts: {
            test: `bun test ${join(clone, "test/native-fixture-conservation.test.ts")} --test-name-pattern 'Git-anchored|assertion deletion|wrong Git|unlisted assertion|omitted transitions|snapshot content'`,
          },
        }),
      );
      const tests = spawnSync(process.execPath, ["run", "--cwd", runner, "test"], {
        encoding: "utf8",
      });
      expect(tests.status).toBe(0);
      expect(tests.stderr).toContain("7 pass");
      const file = join(clone, "native/Apps/ShepherdMac/Tests/LiveServerTests.swift");
      const intact = readFileSync(file, "utf8");
      for (const signature of [
        "liveSignInAndRestore",
        "theSessionListRendersAgainstTheLiveServer",
      ]) {
        const start = intact.indexOf(`func ${signature}()`);
        const offset = intact.indexOf("#expect(", start);
        expect(offset).toBeGreaterThan(start);
        // Replacing the assertion macro removes that original assertion while retaining valid tokens.
        writeFileSync(
          file,
          intact.slice(0, offset) + intact.slice(offset).replace("#expect(", "consume("),
        );
        const deleted = check();
        expect(deleted.status).not.toBe(0);
        expect(deleted.stderr).toContain("fixture destination drift");
      }
      writeFileSync(file, intact.replace("#require(fixtureToken)", "#require(unlistedToken)"));
      expect(check().status).not.toBe(0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 120_000);
});
