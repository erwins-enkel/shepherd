import { describe, expect, it } from "bun:test";
import {
  decideToolGuard,
  hookOutput,
  isTmpfsPath,
  type ToolGuardContext,
  type ToolGuardDenial,
  type ToolGuardEvent,
} from "../scripts/tool-guard.mjs";
import { buildToolGuardFragment, toolGuardMembranePaths } from "../src/tool-guard-hook";
import { buildMembraneFlags } from "../src/sandbox";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A `PreToolUse` body for a Bash call. */
const bash = (command: string, cwd = "/home/u/repo") => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command },
  cwd,
});

/** The agent's own scratch tree. Shepherd points spawns' `TMPDIR` at a DISK-backed dir (#1875)
 *  precisely so worktrees and installs can land there, so it must NOT read as a tmpfs. */
const AGENT_TMP = "/home/u/.cache/shepherd/tmp/claude-1000/sess/scratchpad";
/** Host mounts that genuinely are memory-backed — the only thing the rule may deny. */
const TMPFS = ["/tmp", "/var/tmp", "/dev/shm"];
const DEPS = {
  isTmpfs: (p: string) => TMPFS.some((root) => p === root || p.startsWith(`${root}/`)),
};

/** A decision, read as a denial (the context-only shapes assert through `ctx` instead). */
const deny = (event: ToolGuardEvent | null | undefined) =>
  decideToolGuard(event, DEPS) as ToolGuardDenial | null;
const ctx = (event: ToolGuardEvent) => decideToolGuard(event, DEPS) as ToolGuardContext | null;

describe("#2002 stash rule (retires the worktree-stash notice)", () => {
  it("denies the invocations that touch the shared stack", () => {
    for (const cmd of [
      "git stash",
      "git stash pop",
      "git stash push -m wip",
      "git stash save wip",
      "git stash drop",
      "git stash clear",
      "git stash store abc123",
      "git stash branch topic",
      "git stash apply", // no explicit SHA ⇒ reads the shared stack by index
      "git stash apply stash@{0}",
      "cd /home/u/repo && git stash pop",
      "git -C /home/u/repo stash",
    ]) {
      const d = deny(bash(cmd));
      expect(`${cmd}: ${d?.permissionDecision}`).toBe(`${cmd}: deny`);
      expect(d?.permissionDecisionReason).toContain("refs/stash");
      // The refusal must carry the sanctioned alternative, not just a "no".
      expect(d?.permissionDecisionReason).toContain("git stash create");
    }
  });

  it("allows the sanctioned read-only + create/apply-by-SHA paths", () => {
    for (const cmd of [
      "git stash list",
      "git stash show -p",
      "git stash create",
      "git stash apply 4f2c1ab",
      "git show HEAD:src/x.ts",
      "git diff origin/main",
    ])
      expect(`${cmd}: ${deny(bash(cmd))}`).toBe(`${cmd}: null`);
  });

  it("does not fire on prose that merely mentions the command", () => {
    // The rule inspects the head of each segment, so a quoted mention is not an invocation.
    expect(deny(bash('echo "never run git stash here"'))).toBeNull();
    expect(deny(bash("gh pr comment -b 'do not git stash'"))).toBeNull();
  });

  it("does not fire on a mention that carries its own separator", () => {
    // The dangerous case: a quoted `;` or newline would split a naive scanner's segment and turn
    // MENTIONED-as-data into INVOKED, hard-blocking a legitimate commit or PR body.
    for (const cmd of [
      'git commit -m "a; git stash pop"',
      'git commit -m "fixes the crash; git stash pop was the trigger"',
      'gh pr create --body "line one\ngit stash pop\nline three"',
      "cat <<EOF\ngit stash pop\nEOF",
      "cat <<-'MSG'\ngit stash pop\nMSG",
      `gh pr create --body "$(cat <<'EOF'\ngit stash pop\nEOF\n)"`,
      'echo "a | git stash" "b && git stash"',
    ])
      // Not "no decision" — a `gh pr create` row still gets its PR-time context; never a BLOCK.
      expect(`${cmd}: ${deny(bash(cmd))?.permissionDecision}`).toBe(`${cmd}: undefined`);
  });

  it("still denies a real invocation behind any separator", () => {
    // The flip side: quoting awareness must not make the rule blind to genuine command positions.
    for (const cmd of [
      "echo hi; git stash",
      "git status\ngit stash pop",
      "git fetch | tee log.txt; git stash drop",
      "cat <<EOF > note.md\njust text\nEOF\ngit stash",
    ])
      expect(`${cmd}: ${deny(bash(cmd))?.permissionDecision}`).toBe(`${cmd}: deny`);
  });

  it("takes no decision at all on an ambiguous command line", () => {
    // Unterminated quote / heredoc ⇒ the parse is a guess, and a guess must never hard-block.
    expect(deny(bash('git commit -m "unterminated'))).toBeNull();
    expect(deny(bash("cat <<EOF\ngit stash pop\n"))).toBeNull();
  });
});

describe("#2002 tmpfs rules (retire the tmpfs-worktree notice)", () => {
  it("denies a worktree added under any tmpfs root", () => {
    for (const cmd of [
      "git worktree add /tmp/wt main",
      "git worktree add /var/tmp/wt",
      "git worktree add /dev/shm/wt",
      "cd /tmp && git worktree add relative-wt",
      // A flag's value survives the flag filter, so the real path is not always the first operand.
      "git worktree add -b feat /tmp/wt",
      "git worktree add --detach /dev/shm/wt HEAD",
    ]) {
      const d = deny(bash(cmd));
      expect(`${cmd}: ${d?.permissionDecision}`).toBe(`${cmd}: deny`);
      expect(d?.permissionDecisionReason).toContain("df -i");
    }
  });

  it("allows a worktree on the repo's own filesystem", () => {
    expect(deny(bash("git worktree add ../scratch-wt main"))).toBeNull();
    expect(deny(bash("git worktree add /home/u/wt"))).toBeNull();
  });

  it("denies a dependency install whose effective cwd is on tmpfs", () => {
    for (const [cmd, cwd] of [
      ["bun install", "/tmp/x"],
      ["npm install", "/tmp/agent-scratch"],
      ["pnpm install --frozen-lockfile", "/tmp"],
      ["yarn", "/dev/shm/p"],
      ["npm ci", "/var/tmp/p"],
      ["cd /tmp/p && bun install", "/home/u/repo"], // cd moves the effective cwd
    ] as const) {
      const d = deny(bash(cmd, cwd));
      expect(`${cmd}: ${d?.permissionDecision}`).toBe(`${cmd}: deny`);
      expect(d?.permissionDecisionReason).toMatch(/inode/i);
    }
  });

  it("abstains when a `cd` moves somewhere this parse cannot name", () => {
    // Keeping the PREVIOUS cwd after an unresolvable `cd` judges the install against a directory
    // it is not running in — and with a tmpfs starting cwd (the agent's own scratch, or `/tmp`
    // under the bwrap membrane) that hard-denies a legitimate `cd ~/repo && bun install`, naming
    // the stale path as the reason. A shell-expanded target drops the claim instead.
    for (const cmd of [
      "cd ~/repo && bun install",
      "cd $HOME/repo && bun install",
      'cd "$(git rev-parse --show-toplevel)" && npm ci',
      "cd `pwd`/pkg && pnpm install",
      "cd && bun install", // bare `cd` is `cd $HOME`
    ])
      expect(`${cmd}: ${deny(bash(cmd, "/tmp/x"))}`).toBe(`${cmd}: null`);
  });

  it("never fabricates a path out of an unexpanded word", () => {
    // `$TMPDIR/wt` under cwd `/tmp/x` must not "resolve" to `/tmp/x/$TMPDIR/wt` and be denied.
    expect(deny(bash("git worktree add $TMPDIR/wt", "/tmp/x"))).toBeNull();
    expect(deny(bash("git worktree add ~/wt", "/tmp/x"))).toBeNull();
    // A RESOLVABLE relative target still resolves against the real cwd, and still denies.
    expect(deny(bash("cd sub && bun install", "/tmp/x"))?.permissionDecisionReason).toContain(
      "/tmp/x/sub",
    );
  });

  it("leaves ordinary installs in the worktree alone", () => {
    for (const cmd of ["bun install", "cd ui && bun install", "npm ci", "pnpm add -D vitest"])
      expect(`${cmd}: ${deny(bash(cmd))}`).toBe(`${cmd}: null`);
    // A non-install invocation of the same binary is never the hazard, even on tmpfs.
    expect(deny(bash("bun run build", "/tmp/x"))).toBeNull();
    expect(deny(bash("npm run lint", "/tmp/x"))).toBeNull();
  });
});

describe("#2002 the guard fails open", () => {
  it("has no opinion on non-Bash tools, empty or malformed events", () => {
    expect(deny(null)).toBeNull();
    expect(deny(undefined)).toBeNull();
    expect(deny({ tool_name: "Read", tool_input: { file_path: "/tmp/x" } })).toBeNull();
    expect(deny({ tool_name: "Bash" })).toBeNull();
    expect(deny({ tool_name: "Bash", tool_input: {} })).toBeNull();
    expect(deny(bash("   "))).toBeNull();
  });

  it("cannot decide from a relative path with no usable cwd", () => {
    expect(
      decideToolGuard({ tool_name: "Bash", tool_input: { command: "bun install" } }),
    ).toBeNull();
  });

  it("asks the kernel whether a path is tmpfs, and answers a new dir from its parent", () => {
    const TMPFS_MAGIC = 0x01021994;
    const fake = (byPath: Record<string, number>) => (p: string) => {
      if (!(p in byPath)) throw new Error("ENOENT");
      return { type: byPath[p]! };
    };
    expect(isTmpfsPath("/tmp", fake({ "/tmp": TMPFS_MAGIC }))).toBe(true);
    expect(isTmpfsPath("/home/u/repo", fake({ "/home/u/repo": 0x9123683e }))).toBe(false);
    // A worktree path that does not exist yet is judged by the filesystem it would land on.
    expect(isTmpfsPath("/tmp/new/wt", fake({ "/tmp": TMPFS_MAGIC }))).toBe(true);
    // Unanswerable all the way to "/" ⇒ no claim, so no denial.
    expect(isTmpfsPath("/tmp/new/wt", fake({}))).toBe(false);
  });

  it("never treats the agent's disk-backed TMPDIR as a hazard (#1875)", () => {
    // Shepherd redirects every spawn's TMPDIR to `~/.cache/shepherd/tmp` SO THAT worktrees and
    // installs are safe there. Deriving deny-roots from $TMPDIR inverted that and hard-blocked the
    // one location the redirect exists to provide — with a reason that misstated the filesystem.
    expect(deny(bash(`git worktree add ${AGENT_TMP}/wt`))).toBeNull();
    expect(deny(bash("bun install", AGENT_TMP))).toBeNull();
    expect(deny(bash("npm ci", `${AGENT_TMP}/nested/pkg`))).toBeNull();
    // The real host tmpfs is still denied.
    expect(deny(bash("git worktree add /tmp/wt"))?.permissionDecision).toBe("deny");
  });
});

describe("#2002 deterministic backstops for the moved notices", () => {
  it("carries the one-PR + manual-steps rules at `gh pr create`", () => {
    // The skill is model-invoked; this fires on the exact call that matters, so the two invariants
    // bind even when the skill is never opened.
    const d = ctx(bash("gh pr create --base main --title x --body y"));
    expect(d?.additionalContext).toContain("ONE pull request");
    expect(d?.additionalContext).toContain("shepherd:manual-steps");
    expect(d?.additionalContext).toContain("Manual-Step:");
    expect(d?.additionalContext).toContain("shepherd-pull-requests");
    // It informs, it does not gate: no permission decision rides along.
    expect(d).not.toHaveProperty("permissionDecision");
  });

  it("does not fire on other gh subcommands", () => {
    for (const cmd of ["gh pr view 12", "gh pr checks --watch", "gh issue create -t x"])
      expect(`${cmd}: ${ctx(bash(cmd))}`).toBe(`${cmd}: null`);
  });

  it("warns about a detached job when a call is backgrounded", () => {
    expect(ctx(bash("bun run dev &"))?.additionalContext).toContain("PID 1");
    expect(
      (
        decideToolGuard(
          { tool_name: "Bash", tool_input: { command: "bun run dev", run_in_background: true } },
          DEPS,
        ) as ToolGuardContext | null
      )?.additionalContext,
    ).toContain("PID 1");
    // `&&` is a list operator, not backgrounding.
    expect(ctx(bash("bun run lint && bun test"))).toBeNull();
  });

  it("lets a denial win over any context it could also have injected", () => {
    const d = deny(bash("git stash && gh pr create"));
    expect(d?.permissionDecision).toBe("deny");
  });
});

describe("#2002 hook envelope", () => {
  it("wraps a decision in the exact shape Claude Code reads", () => {
    expect(hookOutput(deny(bash("git stash")))).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("refs/stash"),
      },
    });
  });

  it("stays silent when there is no decision", () => {
    expect(hookOutput(null)).toBeNull();
  });
});

describe("#2002 settings fragment", () => {
  it("registers one command hook on Bash, with both paths quoted", () => {
    const f = buildToolGuardFragment({
      enabled: true,
      interpreter: "/usr/bin/node",
      scriptPath: "/opt/she pherd/scripts/tool-guard.mjs",
    }) as { PreToolUse: { matcher: string; hooks: { type: string; command: string }[] }[] };
    expect(f.PreToolUse).toHaveLength(1);
    expect(f.PreToolUse[0]!.matcher).toBe("Bash");
    expect(f.PreToolUse[0]!.hooks[0]!.type).toBe("command");
    expect(f.PreToolUse[0]!.hooks[0]!.command).toBe(
      "'/usr/bin/node' '/opt/she pherd/scripts/tool-guard.mjs'",
    );
  });

  it("emits nothing at all when the kill switch is off", () => {
    expect(buildToolGuardFragment({ enabled: false })).toEqual({});
    expect(toolGuardMembranePaths(false)).toEqual([]);
  });
});

describe("#2002 the guard is reachable inside the membrane", () => {
  const membrane = {
    worktreePath: "/home/u/wt",
    gitCommonDir: "/home/u/repo/.git",
    isolated: true,
    repoPath: "/home/u/repo",
    claudeDir: "/home/u/.claude",
    home: "/home/u",
    nodeBinReal: "/usr/lib/node/bin/node",
  };

  it("binds every support path RO at the same path", () => {
    // The notices these paths replace are dropped host-side, so an unbound script would leave a
    // sandboxed session with neither the notice nor the deny.
    const flags = buildMembraneFlags(
      { ...membrane, agentSupportPaths: ["/opt/shepherd/scripts/tool-guard.mjs"] },
      { exists: () => true },
    );
    const i = flags.indexOf("/opt/shepherd/scripts/tool-guard.mjs");
    expect(i).toBeGreaterThan(0);
    expect(flags[i - 1]).toBe("--ro-bind-try");
    expect(flags[i + 1]).toBe("/opt/shepherd/scripts/tool-guard.mjs");
  });

  it("adds no flags when there are no support paths", () => {
    const base = buildMembraneFlags(membrane, { exists: () => true });
    expect(
      buildMembraneFlags({ ...membrane, agentSupportPaths: [] }, { exists: () => true }),
    ).toEqual(base);
  });
});

// ── the CLI entry: the only part Claude Code actually executes ───────────────────────────────────

describe("#2002 CLI entry (stdin → stdout)", () => {
  const SCRIPT = join(import.meta.dir, "..", "scripts", "tool-guard.mjs");
  // `node`, not process.execPath: the hook runs under the node binary Shepherd resolves (and the
  // membrane binds), never under bun — and this matches how test/check-model-mirror.test.ts runs
  // the repo's other .mjs scripts.
  const NODE = "node";

  /** Run the guard exactly as the hook does: body on stdin, decision on stdout. */
  const run = async (event: unknown, path = SCRIPT) => {
    const p = Bun.spawn([NODE, path], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    p.stdin.write(typeof event === "string" ? event : JSON.stringify(event));
    await p.stdin.end();
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    return { out, code };
  };

  it("emits the deny envelope and exits 0", async () => {
    const { out, code } = await run(bash("git stash"));
    expect(code).toBe(0); // a non-zero exit would surface as a hook ERROR to the agent
    expect(JSON.parse(out)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("refs/stash"),
      },
    });
  });

  it("stays silent — exit 0, no output — when it has no opinion", async () => {
    for (const event of [bash("git status"), bash("bun run lint")]) {
      const { out, code } = await run(event);
      expect(out).toBe("");
      expect(code).toBe(0);
    }
  });

  it("fails open on malformed input rather than erroring", async () => {
    for (const body of ["not json at all", "", "null"]) {
      const { out, code } = await run(body);
      expect(`${JSON.stringify(body)}: ${out} ${code}`).toBe(`${JSON.stringify(body)}:  0`);
    }
  });

  it("runs when invoked through a symlinked path", async () => {
    // Regression guard for the main-module check: Node realpath-resolves the entry behind
    // `import.meta.url` but not argv[1], so a bare `resolve()` compare silently skipped main() —
    // the hook emitted NOTHING while the prompt had already dropped both hazard notices.
    const dir = mkdtempSync(join(tmpdir(), "tool-guard-link-"));
    const link = join(dir, "linked-guard.mjs");
    try {
      symlinkSync(SCRIPT, link);
      const { out } = await run(bash("git stash"), link);
      expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe("deny");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits nothing when imported rather than executed", async () => {
    const p = Bun.spawn(
      [NODE, "--input-type=module", "-e", `await import(${JSON.stringify(SCRIPT)})`],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    p.stdin.write(JSON.stringify(bash("git stash")));
    await p.stdin.end();
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    expect(`${out}|${code}`).toBe("|0");
  });
});
