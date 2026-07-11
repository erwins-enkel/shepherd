import { importEpicLinks, type ImportResult } from "./epic-import";
import type { GitForge } from "./forge/types";
import type { EpicDraftChild, EpicDraftContent } from "./types";

/**
 * Epic-authoring materializer — the server-owned write path behind the approve gate (issue #1507).
 *
 * The shaping agent produces a structured {@link EpicDraftContent} and STOPS; it never writes to
 * GitHub. Only {@link materializeEpicDraft} — reached solely through the approve endpoint — creates
 * issues. Split into pure helpers (validate / render, unit-tested) and the one forge-driven async.
 */

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface ValidatedEpicDraft extends EpicDraftContent {
  /** children re-ordered so every child appears after all of its blockers (topological). */
  children: EpicDraftChild[];
}

export type ValidateResult = { ok: true; value: ValidatedEpicDraft } | { ok: false; error: string };

/** Topologically sort children so each appears after its blockers. Returns null on a cycle.
 *  Stable: preserves input order among children with no ordering constraint between them. */
export function topoSortChildren(children: EpicDraftChild[]): EpicDraftChild[] | null {
  const byKey = new Map(children.map((c) => [c.key, c]));
  const state = new Map<string, 0 | 1 | 2>(); // 0/undefined=unseen, 1=on-stack, 2=done
  const out: EpicDraftChild[] = [];
  const visit = (key: string): boolean => {
    const s = state.get(key);
    if (s === 2) return true;
    if (s === 1) return false; // back-edge → cycle
    state.set(key, 1);
    const child = byKey.get(key);
    if (child) {
      for (const b of child.blockedBy) {
        // edges to non-members are rejected in validate(); guard here so a stray one can't loop.
        if (byKey.has(b) && !visit(b)) return false;
      }
    }
    state.set(key, 2);
    if (child) out.push(child);
    return true;
  };
  for (const c of children) {
    if (!visit(c.key)) return null;
  }
  return out;
}

/** Validate child keys + titles, returning the set of keys or an error string. */
function validateChildKeys(children: EpicDraftChild[]): { keys: Set<string> } | { error: string } {
  const seen = new Set<string>();
  for (const c of children) {
    if (typeof c.key !== "string" || !KEY_RE.test(c.key))
      return { error: `invalid child key ${JSON.stringify(c.key)}` };
    if (seen.has(c.key)) return { error: `duplicate child key "${c.key}"` };
    seen.add(c.key);
    if (typeof c.title !== "string" || c.title.trim() === "")
      return { error: `child "${c.key}" title is required` };
  }
  return { keys: seen };
}

/** Validate dependency edges resolve to members and are not self-loops. Returns an error or null. */
function validateChildEdges(children: EpicDraftChild[], keys: Set<string>): string | null {
  for (const c of children) {
    for (const b of c.blockedBy) {
      if (b === c.key) return `child "${c.key}" is blocked by itself`;
      if (!keys.has(b)) return `child "${c.key}" blocked by unknown key "${b}"`;
    }
  }
  return null;
}

/** Validate an authored draft and return its children in dependency (topological) order.
 *  Rejects: empty parent title, zero children, blank/duplicate/malformed keys, blank child
 *  titles, self-edges, edges to unknown keys, and dependency cycles. */
export function validateEpicDraft(content: EpicDraftContent): ValidateResult {
  const parent = content.parent;
  if (!parent || typeof parent.title !== "string" || parent.title.trim() === "")
    return { ok: false, error: "parent title is required" };
  const children = content.children;
  if (!Array.isArray(children) || children.length === 0)
    return { ok: false, error: "at least one child issue is required" };

  const keyResult = validateChildKeys(children);
  if ("error" in keyResult) return { ok: false, error: keyResult.error };
  const edgeError = validateChildEdges(children, keyResult.keys);
  if (edgeError) return { ok: false, error: edgeError };

  const ordered = topoSortChildren(children);
  if (!ordered) return { ok: false, error: "dependency cycle between children" };
  return { ok: true, value: { parent: content.parent, children: ordered } };
}

/** Render a `- ` bullet list from non-blank trimmed lines, or "" when none. */
function bullets(items: string[]): string {
  const rows = (items ?? []).map((s) => s.trim()).filter(Boolean);
  return rows.length ? rows.map((r) => `- ${r}`).join("\n") : "";
}

/** The child issue body forwarded as the spawn brief: authored body + an acceptance section. */
function renderChildBody(child: EpicDraftChild): string {
  const parts = [child.body.trim()];
  const acc = bullets(child.acceptanceCriteria);
  if (acc) parts.push(`## Acceptance criteria\n${acc}`);
  return parts.filter(Boolean).join("\n\n") + "\n";
}

/** Build the epic-dag fence (when there are edges) or a `- [ ] #N` checklist (when there are
 *  none) from the resolved key→number map, in the draft's (topological) child order. */
function renderMarker(children: EpicDraftChild[], keyToNumber: Record<string, number>): string {
  const hasEdges = children.some((c) => c.blockedBy.length > 0);
  if (!hasEdges) {
    return children.map((c) => `- [ ] #${keyToNumber[c.key]}`).join("\n");
  }
  const lines = children.map((c) => {
    const n = keyToNumber[c.key];
    if (c.blockedBy.length === 0) return `#${n}`;
    const blockers = c.blockedBy.map((b) => `#${keyToNumber[b]}`).join(", ");
    return `#${n} <- ${blockers}`;
  });
  return "```epic-dag\n" + lines.join("\n") + "\n```";
}

/** Compose the parent issue body: authored prose, an acceptance-criteria section, a non-goals
 *  section, then the server-generated structural marker (real digits — never placeholders). */
export function renderParentBody(
  content: ValidatedEpicDraft,
  keyToNumber: Record<string, number>,
): string {
  const { parent, children } = content;
  const parts = [parent.body.trim()];
  const acc = bullets(parent.acceptanceCriteria);
  if (acc) parts.push(`## Acceptance criteria\n${acc}`);
  const ng = bullets(parent.nonGoals);
  if (ng) parts.push(`## Non-goals\n${ng}`);
  parts.push(renderMarker(children, keyToNumber));
  return parts.filter(Boolean).join("\n\n") + "\n";
}

/** True when the forge can create issues at all (else the epic can't be materialized). */
export function forgeSupportsIssueCreation(forge: GitForge): boolean {
  return typeof forge.createIssue === "function";
}

export interface MaterializeResult {
  parentNumber: number;
  parentUrl: string;
  childNumbers: Record<string, number>;
  importResult: ImportResult | null;
}

export interface MaterializeOptions {
  /** key → number already created in a prior attempt; those children are skipped (resume). */
  alreadyCreated?: Record<string, number>;
  /** parent already created in a prior attempt (skip re-creating it). */
  parentNumber?: number | null;
  parentUrl?: string | null;
  /** persist a child's number the instant its issue exists (before the next create). */
  onChildCreated?: (key: string, number: number) => void | Promise<void>;
  /** persist the parent's number/url the instant it exists. */
  onParentCreated?: (number: number, url: string) => void | Promise<void>;
}

/**
 * Create the child issues (in dependency order), then the parent (with the epic-dag fence built
 * from real numbers), then best-effort wire native sub-issue + blocked_by links via importEpicLinks.
 *
 * Resumable: children/parent already present in the options (from a prior attempt's persisted state)
 * are skipped, so a retry after a mid-way failure never double-creates. The caller (approve route)
 * persists each number via the on*Created callbacks and guards concurrency/idempotency with a CAS.
 */
export async function materializeEpicDraft(
  forge: GitForge,
  content: ValidatedEpicDraft,
  opts: MaterializeOptions = {},
): Promise<MaterializeResult> {
  if (!forge.createIssue) throw new Error("forge does not support issue creation");

  const childNumbers: Record<string, number> = { ...(opts.alreadyCreated ?? {}) };
  for (const child of content.children) {
    if (childNumbers[child.key] != null) continue; // already created in a prior attempt
    const { number } = await forge.createIssue({
      title: child.title.trim(),
      body: renderChildBody(child),
    });
    childNumbers[child.key] = number;
    await opts.onChildCreated?.(child.key, number);
  }

  const parentBody = renderParentBody(content, childNumbers);
  let parentNumber = opts.parentNumber ?? null;
  let parentUrl = opts.parentUrl ?? null;
  if (parentNumber == null) {
    const created = await forge.createIssue({
      title: content.parent.title.trim(),
      body: parentBody,
    });
    parentNumber = created.number;
    parentUrl = created.url;
    await opts.onParentCreated?.(parentNumber, parentUrl);
  }

  // Native links are an enhancement over the body fence (which already makes the epic recognized);
  // a non-native forge (no addSubIssue/addBlockedBy) throws here — caught, markdown fence stands.
  // importEpicLinks itself skips already-present links, so a resume re-run is safe.
  let importResult: ImportResult | null;
  try {
    importResult = await importEpicLinks(forge, parentNumber, parentBody);
  } catch {
    importResult = null;
  }

  return { parentNumber, parentUrl: parentUrl ?? "", childNumbers, importResult };
}
