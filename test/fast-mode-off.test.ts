// #4244: every operator-less Claude spawn is hard-off for Fast mode. The pin lives where every
// spawn's env is assembled (the herdr shim + the membrane's --setenv), so these tests feed each
// transient kind through the SAME tails the roles use and read what the final process gets.
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildTransientAgentArgv, type TransientAgentKind } from "../src/transient-agent-argv";
import { apiKeyPassthroughEnv } from "../src/spawn-auth";
import { assembleAuxSpawn, type AuxPatch, type MembraneEnv } from "../src/spawn-membrane";
import { fastModeOffValue } from "./helpers/fast-mode";

const KINDS: TransientAgentKind[] = ["reviewer", "doc", "writer-ro", "writer-only"];

const stubEnv: MembraneEnv = {
  claudeDir: "/stub/.claude",
  home: "/stub/home",
  nodeBinReal: "/stub/bin/node",
  extraEnv: { LANG: "C.UTF-8" },
};

describe("every transient kind reaches its process with CLAUDE_CODE_DISABLE_FAST_MODE=1", () => {
  for (const kind of KINDS) {
    const { argv } = buildTransientAgentArgv(kind, { model: null, prompt: "go" });

    test(`${kind}: unwrapped (herdr.start with the helper env)`, () => {
      expect(argv[0]).toBe("claude");
      expect(fastModeOffValue(argv, apiKeyPassthroughEnv(false))).toBe("1");
    });

    test(`${kind}: wrapped by the membrane, even over a plugin patch env of 0`, () => {
      const patch: AuxPatch = {
        backend: "bwrap",
        claudeJsonCopy: null,
        baseEnv: undefined,
        patchEnv: { CLAUDE_CODE_DISABLE_FAST_MODE: "0" },
        extraArgs: [],
        reviewer: kind === "reviewer",
      };
      const { wrapped, spawnEnv } = assembleAuxSpawn(patch, {
        argv,
        worktreePath: "/wt/task",
        repoPath: "/repo",
        worktree: { gitCommonDir: () => "/repo/.git" },
        seams: { detectBackend: () => "bwrap", membraneEnv: () => stubEnv },
      });
      expect(wrapped[0]).toBe("bwrap");
      expect(fastModeOffValue(wrapped, spawnEnv)).toBe("1");
    });
  }
});

test("only SessionService sets the allowFastMode opt-out", () => {
  const sets = /\ballowFastMode\s*[:=](?!=)|\{\s*allowFastMode\s*[,}]/;
  const setters = [...new Bun.Glob("**/*.ts").scanSync({ cwd: "src" })].filter((f) =>
    sets.test(readFileSync(join("src", f), "utf8")),
  );
  expect(setters).toEqual(["service.ts"]);
});
