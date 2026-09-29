import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionService } from "../src/service";
import { SessionStore } from "../src/store";
import type { AgentProvider } from "../src/types";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(provider: AgentProvider, failSpawn = false) {
  const dir = mkdtempSync(join(tmpdir(), "shepherd long task "));
  dirs.push(dir);
  const store = new SessionStore(":memory:");
  const launches: { argv: string[]; files: string[]; text: string[] }[] = [];
  const worktree = {
    ensureBaseRef: async () => {},
    branchExists: () => false,
    create: () => ({ worktreePath: dir, branch: "shepherd/long-task", isolated: false }),
    remove: () => {},
  };
  const service = new SessionService({
    store,
    namer: async () => "long-task",
    worktree: worktree as any,
    herdr: {
      start: async (_name: string, _cwd: string, argv: string[]) => {
        const files = readdirSync(dir).filter((f) => f.startsWith(".shepherd-task-"));
        launches.push({ argv, files, text: files.map((f) => readFileSync(join(dir, f), "utf8")) });
        if (failSpawn) throw new Error("spawn unavailable");
        return {
          terminalId: "term_long",
          cwd: dir,
          agent: provider,
          agentStatus: "working",
          paneId: "p",
          tabId: "t",
          workspaceId: "w",
        };
      },
      list: () => [],
    } as any,
  });
  const create = (prompt: string) =>
    service.create({
      repoPath: dir,
      baseBranch: "main",
      prompt,
      agentProvider: provider,
      model: null,
      images: [],
    });
  return { dir, store, service, worktree, launches, create };
}

for (const provider of ["claude", "codex"] as const) {
  test(`${provider}: long task is available in full before spawn, outside argv`, async () => {
    const h = harness(provider);
    const prompt = `START\n${"ä🙂'".repeat(40_000)}\nEND-REQUIREMENT`;
    const session = await h.create(prompt);
    expect(h.launches).toHaveLength(1);
    const launch = h.launches[0]!;
    expect(launch.text).toEqual([prompt]);
    expect(launch.argv.join(" ")).not.toContain(prompt);
    expect(launch.argv.at(-1)).toContain(join(h.dir, launch.files[0]!));
    expect(launch.argv.at(-1)!.length).toBeLessThan(100_000);
    expect(h.store.get(session.id)?.prompt).toBe(prompt);
    if (provider === "codex") expect(launch.argv.at(-1)).toContain("<shepherd-session");
    else expect(launch.argv).toContain("--append-system-prompt");
  });
}

test("failed spawn removes only its own task file in a non-isolated checkout", async () => {
  const h = harness("claude", true);
  await expect(h.create("x".repeat(12_349))).rejects.toThrow("spawn unavailable");
  expect(h.launches[0]!.text).toEqual(["x".repeat(12_349)]);
  expect(readdirSync(h.dir).filter((f) => f.startsWith(".shepherd-task-"))).toEqual([]);
});

for (const length of [7_999, 8_000, 8_001, 12_349]) {
  test(`task delivery boundary at ${length} characters`, async () => {
    const h = harness("claude");
    const prompt = "x".repeat(length);
    await h.create(prompt);
    const launch = h.launches[0]!;
    if (length <= 8_000) {
      expect(launch.files).toEqual([]);
      expect(launch.argv.at(-1)).toBe(prompt);
    } else {
      expect(launch.text).toEqual([prompt]);
      expect(launch.argv.at(-1)).not.toBe(prompt);
    }
  });
}

test("task file write failure prevents starting an agent", async () => {
  const h = harness("claude");
  rmSync(h.dir, { recursive: true });
  await expect(h.create("x".repeat(12_349))).rejects.toThrow();
  expect(h.launches).toHaveLength(0);
});

test("provider replacement preserves the long task and keeps the original file readable", async () => {
  const h = harness("claude");
  const prompt = "x".repeat(12_349) + "END";
  const original = await h.create(prompt);
  const replaced = await h.service.replaceAgent(original.id, {
    agentProvider: "codex",
    model: null,
  });
  expect(replaced.prompt).toBe(prompt);
  expect(h.launches).toHaveLength(2);
  expect(h.launches[1]!.text).toHaveLength(2);
  expect(h.launches[1]!.text.every((text) => text.includes(prompt))).toBe(true);
  expect(h.launches[1]!.argv.join(" ")).not.toContain(prompt);
});

test("reviewer can read a long single line losslessly using only bounded Read lines", async () => {
  const { prepareTaskPrompt } = await import("../src/task-prompt-file");
  const h = harness("claude");
  const text = `HEAD${'\u0000🙂\\"'.repeat(10_000)}TAIL`;
  const result = prepareTaskPrompt(text, h.dir, "review");
  expect(readFileSync(result.filePath!, "utf8")).toBe(text);
  const view = result.filePath!.replace(/\.txt$/, ".jsonl");
  expect(readdirSync(h.dir)).toContain(view.split("/").at(-1)!);
  const lines = readFileSync(view, "utf8").trimEnd().split("\n");
  expect(lines.every((line) => line.length < 2000)).toBe(true);
  expect(lines.map((line) => JSON.parse(line).text).join("")).toBe(text);
  expect(result.prompt).toContain(view);
});

test("failed reviewer task preparation removes its worktree and preserves the error", async () => {
  const { prepareReviewerTaskPrompt } = await import("../src/task-prompt-file");
  const h = harness("claude");
  rmSync(h.dir, { recursive: true });
  const removed: string[] = [];
  expect(() =>
    prepareReviewerTaskPrompt("x".repeat(12_349), h.dir, (path) => removed.push(path)),
  ).toThrow(/ENOENT/);
  expect(removed).toEqual([h.dir]);
});

test("relaunch recreates a long task from the stored text in the new worktree", async () => {
  const h = harness("claude");
  const prompt = "x".repeat(12_349) + "END";
  const original = await h.create(prompt);
  const nextDir = mkdtempSync(join(tmpdir(), "shepherd relaunched task "));
  dirs.push(nextDir);
  // The existing dependency seam models the newly allocated worktree.
  h.worktree.create = () => ({
    worktreePath: nextDir,
    branch: "shepherd/relaunched",
    isolated: false,
  });
  const relaunched = await h.service.relaunch(original.id);
  expect(relaunched.prompt).toBe(prompt);
  const files = readdirSync(nextDir).filter((f) => f.startsWith(".shepherd-task-"));
  expect(files).toHaveLength(1);
  expect(readFileSync(join(nextDir, files[0]!), "utf8")).toBe(prompt);
  expect(h.launches[1]!.argv.join(" ")).toContain(nextDir);
});
