// `ctx.issues` (#2462): validates plugin input, resolves the repo's forge per call, and files
// through the shared `src/issue-create.ts` path so untrusted sections are fenced by core.

import type { GitForge, Issue } from "../forge/types";
import {
  composeIssueBody,
  createIssueWithLabels,
  issueForgeGap,
  type IssueOp,
} from "../issue-create";
import { safeRepoDir } from "../validate";
import { scrubFenceTokens } from "../untrusted";
import {
  PluginIssuesError,
  type PluginIssue,
  type PluginIssueCreateInput,
  type PluginIssues,
  type PluginUntrustedSection,
} from "./types";

/** Core seams backing `ctx.issues`. Absent (e.g. a test registry) → every call is `no-forge`. */
export interface PluginIssuesDeps {
  repoRoot: string;
  resolveForge(dir: string): GitForge | null;
}

const MAX_TITLE = 200;
// GitHub rejects bodies over 65 536 chars; leave headroom for the fence markers.
const MAX_BODY = 60_000;
const MAX_LABELS = 20;
const MAX_LABEL_LEN = 50;
const MAX_SECTIONS = 20;
const FENCE_LABEL_RE = /^[\w .#:-]{1,64}$/;

function invalid(message: string): never {
  throw new PluginIssuesError("invalid-input", message);
}

function checkNumber(n: unknown): number {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
    invalid("issue number must be a positive integer");
  }
  return n;
}

function isValidLabel(l: unknown): boolean {
  return typeof l === "string" && !!l.trim() && l.length <= MAX_LABEL_LEN && !/[,\r\n]/.test(l);
}

function checkLabels(labels: unknown): string[] {
  if (labels === undefined) return [];
  if (!Array.isArray(labels) || labels.length > MAX_LABELS) {
    invalid(`labels must be an array of ≤ ${MAX_LABELS}`);
  }
  if (!labels.every(isValidLabel)) {
    invalid(`each label must be 1–${MAX_LABEL_LEN} chars without commas or newlines`);
  }
  return labels as string[];
}

function checkSection(u: unknown): PluginUntrustedSection {
  const sec = u as Partial<PluginUntrustedSection> | null;
  if (typeof sec?.label !== "string" || !FENCE_LABEL_RE.test(sec.label)) {
    invalid("untrusted section label must match [A-Za-z0-9_ .#:-]{1,64}");
  }
  if (typeof sec.content !== "string") invalid("untrusted section content must be a string");
  return { label: sec.label, content: sec.content };
}

function checkSections(untrusted: unknown): PluginUntrustedSection[] {
  if (untrusted === undefined) return [];
  if (!Array.isArray(untrusted) || untrusted.length > MAX_SECTIONS) {
    invalid(`untrusted must be an array of ≤ ${MAX_SECTIONS} sections`);
  }
  return untrusted.map(checkSection);
}

/** Backstop for the TRUSTED title (the drain's unfenced task prompt): one line, no control
 *  characters, no fence markers. */
function cleanTitle(raw: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control chars is the point
  return scrubFenceTokens(raw.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")).trim();
}

/** Validate a create call into the forge-ready title/body/labels. */
function checkCreate(o: PluginIssueCreateInput): { title: string; body: string; labels: string[] } {
  const title = typeof o?.title === "string" ? cleanTitle(o.title) : "";
  if (!title || title.length > MAX_TITLE) {
    invalid(`title must be a non-empty string ≤ ${MAX_TITLE} chars`);
  }
  if (typeof o.body !== "string") invalid("body must be a string");
  const labels = checkLabels(o.labels);
  const body = composeIssueBody(o.body, checkSections(o.untrusted));
  if (body.length > MAX_BODY) invalid(`composed body exceeds ${MAX_BODY} chars`);
  return { title, body, labels };
}

function toPluginIssue(i: Issue): PluginIssue {
  return {
    number: i.number,
    title: i.title,
    body: i.body,
    url: i.url,
    labels: [...i.labels],
    state: i.state ?? null,
  };
}

/** Resolve `repo` to a forge able to run `op`, or throw the typed refusal. */
function forgeFor(deps: PluginIssuesDeps | undefined, repo: string, op: IssueOp): GitForge {
  if (!deps) throw new PluginIssuesError("no-forge", "issues are not available in this core");
  const dir = typeof repo === "string" ? safeRepoDir(repo, deps.repoRoot) : null;
  if (!dir) {
    throw new PluginIssuesError("invalid-repo", "repo must be a directory under the repo root");
  }
  const forge = deps.resolveForge(dir);
  const gap = issueForgeGap(forge, op);
  if (gap || !forge) {
    const code = gap ?? "no-forge";
    throw new PluginIssuesError(code, `issues unavailable for repo (${code})`);
  }
  return forge;
}

/** Build the `ctx.issues` surface for one plugin. `log` is the plugin-namespaced warn logger. */
export function makePluginIssues(
  deps: PluginIssuesDeps | undefined,
  log: (msg: string) => void,
): PluginIssues {
  return {
    create: async (repo, o) => {
      const input = checkCreate(o);
      return createIssueWithLabels(forgeFor(deps, repo, "createIssue"), input, log);
    },
    close: async (repo, number, comment) => {
      const n = checkNumber(number);
      if (comment !== undefined && (typeof comment !== "string" || !comment.trim())) {
        invalid("comment must be a non-empty string");
      }
      const forge = forgeFor(deps, repo, "closeIssue");
      if (comment !== undefined) {
        // Refuse BEFORE mutating: a comment the host can't post must not leave a silent close.
        if (!forge.commentIssue) {
          throw new PluginIssuesError("unsupported", "host cannot comment on issues");
        }
        await forge.commentIssue(n, comment);
      }
      await forge.closeIssue?.(n);
    },
    get: async (repo, number) => {
      const n = checkNumber(number);
      const issue = await forgeFor(deps, repo, "getIssue").getIssue?.(n);
      return issue ? toPluginIssue(issue) : null;
    },
  };
}
