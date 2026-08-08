import { getCommands } from "$lib/api";
import type { AgentProvider } from "$lib/types";

/**
 * The New Task recommendation for the public `video-brief` Agent Skill (issue #2053).
 *
 * When a screen recording is attached, an agent that cannot decode it will work from the operator's
 * prose alone and never mention the gap. The public skill closes it — so Shepherd points at it, and
 * does nothing else: no install, no `npx`, no agent-config write. The row is informational.
 *
 * The load-bearing rule is the ASYMMETRY between "installed" and "not installed". A successful
 * inventory that lists the skill proves it is there; a failed or in-flight one proves nothing. So
 * `recommend` is true for exactly one of the four statuses — a `ready` result with no match — and a
 * dead `/api/commands` shows nothing rather than a false "you're missing this".
 */

/** Screen-recording extensions Shepherd accepts as in-session attachments (see src/uploads.ts).
 *  Module-local — `hasVideoAttachment` is the only reader, and the tests exercise it through that. */
const VIDEO_EXTENSIONS = [".mov", ".mp4", ".webm", ".m4v"] as const;

/** The skill's front-matter `name` — the exact string an inventory entry must carry. */
export const VIDEO_BRIEF_SKILL_NAME = "video-brief";

/** Is any COMPLETED attachment a screen recording? Suffix match, case-insensitive: iOS hands over
 *  `IMG_4821.MOV`, and the name rides verbatim from the file the operator picked. */
export function hasVideoAttachment(names: readonly string[]): boolean {
  return names.some((name) => {
    const lower = name.toLowerCase();
    return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
  });
}

/** Where the inventory read stands. `loading` and `failed` are both UNKNOWN — never "missing". */
type VideoSkillStatus = "idle" | "loading" | "ready" | "failed";

/**
 * The `video-brief` inventory for ONE provider, loaded only while a video is attached.
 *
 * Deliberately its own read rather than a share of NewTask's `allCommands`: that list is keyed on
 * `commandProvider`, which flips to claude/codex by slash trigger while the autocomplete menu is
 * open — the wrong question to ask about the provider the task will actually spawn with.
 *
 * Generation-safe (the `IssueData` precedent beside it): each `load()` bumps a monotonic counter and
 * a settlement applies only while its captured generation is current. That closes the A→B→A clobber
 * a bare path/provider comparison would miss, and it is what makes `reset()` cancel-like — an
 * in-flight read can never resurrect a row the operator has since removed the video from.
 */
export class VideoSkillInventory {
  status = $state<VideoSkillStatus>("idle");
  /** Only meaningful when `status === "ready"`. */
  installed = $state(false);
  #generation = 0;

  /** True for exactly one state: a successful inventory that does NOT list the skill. */
  get recommend(): boolean {
    return this.status === "ready" && !this.installed;
  }

  /** Read the inventory for `provider`. `repoPath` may be empty — the server then answers with
   *  user-scope entries only, which is still the right answer for a personally-installed skill. */
  async load(repoPath: string, provider: AgentProvider): Promise<void> {
    const gen = ++this.#generation;
    this.status = "loading";
    try {
      const { commands } = await getCommands(repoPath, { provider });
      if (gen !== this.#generation) return;
      this.installed = commands.some(
        (c) => c.kind === "skill" && c.name === VIDEO_BRIEF_SKILL_NAME,
      );
      this.status = "ready";
    } catch {
      if (gen !== this.#generation) return;
      this.installed = false;
      this.status = "failed";
    }
  }

  /** Back to idle — the last video was removed, so there is nothing to recommend about. */
  reset(): void {
    this.#generation++;
    this.status = "idle";
    this.installed = false;
  }
}
