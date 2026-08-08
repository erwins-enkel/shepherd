import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SlashCommand } from "$lib/types";

// Direct unit seam for the recommendation's decision logic: getCommands is mocked so the four
// inventory statuses (and the generation guard) are observable without a component.
vi.mock("$lib/api", () => ({ getCommands: vi.fn() }));

import { getCommands } from "$lib/api";
import {
  hasVideoAttachment,
  VIDEO_BRIEF_SKILL_NAME,
  VideoSkillInventory,
} from "./video-skill.svelte";

const getCommandsMock = vi.mocked(getCommands);

function cmd(over: Partial<SlashCommand> = {}): SlashCommand {
  return {
    id: "x",
    name: "something",
    displayName: "something",
    description: "",
    scope: "user",
    kind: "skill",
    invocationName: "something",
    sourceNamespace: "claude:user",
    providers: ["claude"],
    invocations: {},
    ...over,
  } as SlashCommand;
}

/** A getCommands call the test resolves by hand — models an in-flight response. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  getCommandsMock.mockReset();
});

describe("hasVideoAttachment", () => {
  it("matches the four screen-recording extensions", () => {
    for (const name of ["a.mov", "a.mp4", "a.webm", "a.m4v"]) {
      expect(hasVideoAttachment([name])).toBe(true);
    }
  });

  it("matches case-insensitively — iOS screen recordings arrive as .MOV", () => {
    expect(hasVideoAttachment(["IMG_4821.MOV"])).toBe(true);
    expect(hasVideoAttachment(["clip.Mp4"])).toBe(true);
  });

  it("ignores non-video attachments", () => {
    expect(hasVideoAttachment(["shot.png", "notes.md", "movie.mov.txt"])).toBe(false);
    expect(hasVideoAttachment([])).toBe(false);
  });

  it("matches on the extension, not a substring of the stem", () => {
    expect(hasVideoAttachment(["mp4-notes.png"])).toBe(false);
  });

  it("is true when ANY attachment is a video", () => {
    expect(hasVideoAttachment(["shot.png", "IMG_4821.MOV"])).toBe(true);
  });
});

describe("VideoSkillInventory", () => {
  it("starts idle and recommends nothing", () => {
    const inv = new VideoSkillInventory();
    expect(inv.status).toBe("idle");
    expect(inv.recommend).toBe(false);
  });

  // Load flips to `loading` SYNCHRONOUSLY, before awaiting. That is what makes a provider switch
  // safe: the caller re-runs load() in the same flush as the provider state change, so the previous
  // provider's verdict can never be painted under the new provider's name.
  it("is loading — NOT missing — while the inventory is in flight", async () => {
    const d = deferred<{ commands: SlashCommand[] }>();
    getCommandsMock.mockReturnValue(d.promise);
    const inv = new VideoSkillInventory();
    inv.load("/repo", "claude");
    expect(inv.status).toBe("loading");
    expect(inv.recommend).toBe(false);
    d.resolve({ commands: [] });
    await d.promise;
    expect(inv.status).toBe("ready");
  });

  it("recommends only once a successful inventory PROVES the skill is absent", async () => {
    getCommandsMock.mockResolvedValue({ commands: [cmd()] });
    const inv = new VideoSkillInventory();
    await inv.load("/repo", "claude");
    expect(inv.status).toBe("ready");
    expect(inv.installed).toBe(false);
    expect(inv.recommend).toBe(true);
  });

  it("does not recommend when the skill is installed", async () => {
    getCommandsMock.mockResolvedValue({
      commands: [cmd(), cmd({ name: VIDEO_BRIEF_SKILL_NAME, kind: "skill" })],
    });
    const inv = new VideoSkillInventory();
    await inv.load("/repo", "claude");
    expect(inv.installed).toBe(true);
    expect(inv.recommend).toBe(false);
  });

  it('requires an EXACT name and kind:"skill" — a near miss is still missing', async () => {
    getCommandsMock.mockResolvedValue({
      commands: [
        cmd({ name: "video-brief-extra", kind: "skill" }),
        cmd({ name: "my-video-brief", kind: "skill" }),
        cmd({ name: VIDEO_BRIEF_SKILL_NAME, kind: "command" }),
        cmd({ name: VIDEO_BRIEF_SKILL_NAME, kind: "plugin" }),
      ],
    });
    const inv = new VideoSkillInventory();
    await inv.load("/repo", "claude");
    expect(inv.installed).toBe(false);
    expect(inv.recommend).toBe(true);
  });

  it("treats a failed inventory as unknown, not missing", async () => {
    getCommandsMock.mockRejectedValue(new Error("offline"));
    const inv = new VideoSkillInventory();
    await inv.load("/repo", "claude");
    expect(inv.status).toBe("failed");
    expect(inv.recommend).toBe(false);
  });

  it("asks for the inventory of the provider it was given", async () => {
    getCommandsMock.mockResolvedValue({ commands: [] });
    const inv = new VideoSkillInventory();
    await inv.load("/repo", "codex");
    expect(getCommandsMock).toHaveBeenCalledWith("/repo", { provider: "codex" });
  });

  it("ignores a stale response after a provider flip (A→B→A generation guard)", async () => {
    const first = deferred<{ commands: SlashCommand[] }>();
    const second = deferred<{ commands: SlashCommand[] }>();
    getCommandsMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const inv = new VideoSkillInventory();
    inv.load("/repo", "claude");
    inv.load("/repo", "codex");
    // The superseded claude read lands LAST and claims the skill is installed. It must not win.
    second.resolve({ commands: [] });
    await second.promise;
    first.resolve({ commands: [cmd({ name: VIDEO_BRIEF_SKILL_NAME })] });
    await first.promise;
    expect(inv.installed).toBe(false);
    expect(inv.recommend).toBe(true);
  });

  it("a late failure from a superseded load cannot blank a fresh result", async () => {
    const first = deferred<{ commands: SlashCommand[] }>();
    getCommandsMock.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ commands: [] });
    const inv = new VideoSkillInventory();
    inv.load("/repo", "claude");
    await inv.load("/repo", "codex");
    first.reject(new Error("offline"));
    await first.promise.catch(() => {});
    expect(inv.status).toBe("ready");
    expect(inv.recommend).toBe(true);
  });

  it("reset() returns to idle and drops any in-flight result", async () => {
    const d = deferred<{ commands: SlashCommand[] }>();
    getCommandsMock.mockReturnValue(d.promise);
    const inv = new VideoSkillInventory();
    inv.load("/repo", "claude");
    inv.reset();
    expect(inv.status).toBe("idle");
    d.resolve({ commands: [] });
    await d.promise;
    expect(inv.status).toBe("idle");
    expect(inv.recommend).toBe(false);
  });

  it("matches the skill's published front-matter name", () => {
    expect(VIDEO_BRIEF_SKILL_NAME).toBe("video-brief");
  });
});
