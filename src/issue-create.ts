// The one issue-filing path (#2462): `POST /api/issues`, `MaintainService.fileIssue` and the
// plugin `ctx.issues` capability all create through here, so labelling and untrusted-content
// fencing cannot drift between callers.

import type { GitForge } from "./forge/types";
import { fenceUntrusted, scrubFenceTokens } from "./untrusted";

/** Why a forge can't serve an issue operation: no forge resolved, a lightweight (local-only,
 *  no backlog) repo, or a host without the needed API. */
export type IssueForgeGap = "no-forge" | "lightweight" | "unsupported";

export type IssueOp = "createIssue" | "closeIssue" | "getIssue";

/** The reason `forge` can't run `op`, or null when it can. Lightweight is reported before a
 *  missing method so a LocalForge repo says what it is rather than "unsupported". */
export function issueForgeGap(
  forge: GitForge | null | undefined,
  op: IssueOp,
): IssueForgeGap | null {
  if (!forge) return "no-forge";
  if (forge.isLightweight === true) return "lightweight";
  return typeof forge[op] === "function" ? null : "unsupported";
}

/** A labelled chunk of externally-sourced text to embed in an issue body as fenced DATA. */
export interface UntrustedSection {
  label: string;
  content: string;
}

/** The issue body: the caller's trusted `body` first (stray fence markers scrubbed so it can't
 *  forge one), then each untrusted section wrapped in its own server-minted fence. */
export function composeIssueBody(body: string, untrusted: UntrustedSection[] = []): string {
  return [scrubFenceTokens(body), ...untrusted.map((u) => fenceUntrusted(u.label, u.content))]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

/** Create an issue, then stamp each label. Labels are best-effort: the issue is the deliverable,
 *  so a label failure is logged and the created issue still returned. `addIssueLabel` creates a
 *  label the repo lacks. Callers check {@link issueForgeGap} first. */
export async function createIssueWithLabels(
  forge: GitForge,
  o: { title: string; body: string; labels?: string[] },
  log: (msg: string) => void,
): Promise<{ number: number; url: string }> {
  if (!forge.createIssue) throw new Error("forge cannot create issues");
  const created = await forge.createIssue({ title: o.title, body: o.body });
  for (const label of o.labels ?? []) {
    try {
      await forge.addIssueLabel?.(created.number, label);
    } catch (err) {
      log(`labelling #${created.number} with "${label}" failed: ${String(err)}`);
    }
  }
  return created;
}
