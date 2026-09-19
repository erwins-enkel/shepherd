/** Manual-merge responsibility gate (#2299).
 *
 *  `.shepherd/roles.json` used to be a DISPLAY of who is up (`annotateHandoff` stamps it on an
 *  open + green PR only). This module turns it into an EXECUTION check for the two operator-facing
 *  merge endpoints: a PR whose reviewer/merger is someone else can still be merged, but only
 *  against an explicit, contextual confirmation that names them — for that PR, that revision, that
 *  action. Nothing here is persisted, and nothing here gates autonomous merges (the merge train,
 *  the drain and epic landing call `forge.merge` directly and deliberately bypass this).
 *
 *  Deliberately NOT derived from `GitState.handoff`: that annotation exists only while the PR is
 *  open AND its checks cleared, so a gate reading it would silently pass on every other PR. This
 *  reads the roles itself.
 *
 *  Pure: no git, no forge, no clock. The endpoints supply roles + identity + the PR's review data. */
import type { MergeResponsibility, PrReviewBlock, PrReviewerState, PrStatus } from "./forge/types";
// TYPE-ONLY, deliberately: repo-roles imports this module at runtime (annotateHandoff stamps the
// verdict), so a value import back would close a cycle. RepoRoles is erased at compile time.
import type { RepoRoles } from "./repo-roles";

/** Whose turn it is when it is not the operator's. Mirrors `HandoffRole` minus `self`. */
export type MergeHandoffRole = "reviewer" | "merger";

/** What the configured roles say about this PR right now. */
export interface MergeGateVerdict {
  /** Foreign responsibility, or null when nobody else is on the hook. */
  handoff: MergeHandoffRole | null;
  /** The responsible login (always set when `handoff` is). */
  handoffWho: string | null;
  /** The configured reviewer's login when they have ACTIVE changes requested. Reported
   *  independently of `handoff` so a pending review is stated separately — a foreign approval
   *  from someone else can leave `handoff` null while this still blocks. */
  reviewBlockBy: string | null;
  /** True when merging means taking over someone else's responsibility. */
  requiresConfirm: boolean;
}

/** The operator's confirmation, echoed back from the dialog. Every field is the value the dialog
 *  SHOWED them; the server re-derives its own and refuses on any drift, so a confirmation cannot
 *  outlive the state it was given for. */
export interface MergeConfirm {
  headSha: string | null;
  baseRefName: string | null;
  handoff: MergeHandoffRole | null;
  handoffWho: string | null;
  reviewBlockBy: string | null;
}

export type MergeConfirmCheck = "ok" | "confirm_required" | "confirm_stale";

/** The configured reviewer's latest terminal state on this PR, matched folded. */
function stateForReviewer(
  reviewerStates: Record<string, PrReviewerState> | undefined,
  reviewer: string | null,
): { login: string; state: PrReviewerState } | null {
  if (!reviewer || !reviewerStates) return null;
  const reviewerLc = reviewer.toLowerCase();
  for (const [login, state] of Object.entries(reviewerStates)) {
    if (login.toLowerCase() === reviewerLc) return { login, state };
  }
  return null;
}

/** Active changes requested by the repo's CONFIGURED reviewer, or undefined. Shared with
 *  `annotateHandoff`'s display annotation so the two cannot disagree about what an outstanding
 *  review block is. The login reported is the host's casing, not the configured one. */
export function reviewBlockFor(
  roles: RepoRoles,
  reviewerStates: Record<string, PrReviewerState> | undefined,
): PrReviewBlock | undefined {
  const scoped = stateForReviewer(reviewerStates, roles.reviewer);
  if (scoped?.state.state !== "changes_requested") return undefined;
  return { reviewer: scoped.login, state: "changes_requested", latestAt: scoped.state.latestAt };
}

/** The verdict reduced to what a PR payload carries, or undefined when nothing is taken over.
 *  This is what `mergeConfirmFrom*` reads and echoes back, so the dialog and this gate can never
 *  derive the responsibility from two different rule sets. */
export function mergeResponsibility(verdict: MergeGateVerdict): MergeResponsibility | undefined {
  if (!verdict.requiresConfirm) return undefined;
  const out: MergeResponsibility = {
    ...(verdict.handoff && verdict.handoffWho
      ? { handoff: verdict.handoff, handoffWho: verdict.handoffWho }
      : {}),
    ...(verdict.reviewBlockBy ? { reviewBlockBy: verdict.reviewBlockBy } : {}),
  };
  // Emptiness is decided on the RESULT: a verdict that requires a confirmation but names nobody
  // (a fork's unnamed maintainer) must not stamp an object that reads as present while naming
  // nobody — the dialog would escalate its wording with nothing to show.
  return Object.keys(out).length ? out : undefined;
}

const NO_GATE: MergeGateVerdict = {
  handoff: null,
  handoffWho: null,
  reviewBlockBy: null,
  requiresConfirm: false,
};

/** GitHub logins are case-insensitive, so every comparison folds — same rule as `computeHandoff`. */
const fold = (v: string | null | undefined): string | null => v?.toLowerCase() ?? null;

/** Decide whether merging this PR takes over someone else's responsibility.
 *
 *  An unconfigured repo (neither role set) is never gated — inferred handoff deliberately does NOT
 *  count, or every PR with a requested reviewer would demand a takeover confirmation.
 *
 *  Fails closed on identity: `me === null` (login unresolvable) makes every configured role read as
 *  foreign, because "we cannot tell who you are" must not read as "you are the merger".
 *
 *  Unlike `configuredHandoff`, an active review block does NOT collapse to "your turn": there the
 *  operator is expected to ACT on the feedback, which is exactly the state a manual merge must not
 *  quietly skip past. */
export function evaluateMergeGate(input: {
  roles: RepoRoles;
  me: string | null;
  latestReview?: PrStatus["latestReview"];
  reviewerStates?: Record<string, PrReviewerState>;
}): MergeGateVerdict {
  const { roles, me } = input;
  if (!roles.reviewer && !roles.merger) return NO_GATE;
  const meLc = fold(me);
  const reviewerIsOther = !!roles.reviewer && fold(roles.reviewer) !== meLc;
  const mergerIsOther = !!roles.merger && fold(roles.merger) !== meLc;

  // Scoped to the CONFIGURED reviewer by reviewBlockFor; additionally scoped to a FOREIGN one here,
  // since changes the operator requested on their own PR are theirs to resolve, not a takeover.
  const block = reviewerIsOther ? reviewBlockFor(roles, input.reviewerStates) : undefined;
  const reviewBlockBy = block?.reviewer ?? null;

  const reviewApproved = input.latestReview?.state === "approved";
  const handoff: MergeHandoffRole | null =
    reviewerIsOther && !reviewApproved ? "reviewer" : mergerIsOther ? "merger" : null;
  const handoffWho =
    handoff === "reviewer" ? roles.reviewer : handoff === "merger" ? roles.merger : null;

  return {
    handoff,
    handoffWho,
    reviewBlockBy,
    requiresConfirm: handoff !== null || reviewBlockBy !== null,
  };
}

/** Two named people drifted apart. Either side unnamed is NOT drift: the client's dialog derives
 *  what it shows from `GitState`'s display annotation, which follows different rules than this gate
 *  (it infers a handoff where the gate requires configured roles, and it collapses an active review
 *  block to "your turn" where the gate does not). Comparing an absent name against a present one
 *  would read those legitimate differences as a change nobody made. */
const namedDrift = (submitted: string | null, derived: string | null): boolean =>
  !!submitted && !!derived && fold(submitted) !== fold(derived);

/** Whether the submitted confirmation still authorizes THIS merge.
 *
 *  `confirm` absent is fine only when nothing needed confirming — that keeps callers that never
 *  open the dialog working on unconfigured repos, and refuses them everywhere else.
 *
 *  Three things can invalidate a confirmation, and only these three:
 *  - the PR's head revision moved (the operator confirmed a different diff),
 *  - its target branch moved (it would land somewhere else),
 *  - the NAMED responsible person changed (they confirmed taking over from someone else).
 *
 *  Each is checked only where both sides are actually known. A value the server could not resolve
 *  means "we don't know", never "it moved" — hosts that cannot answer (Gitea has no open-PR
 *  snapshot) would otherwise have every manual merge refused. The revision stays bound where the
 *  host can bind it: `expectedHeadSha` reaches GitHub as `--match-head-commit` regardless.
 *
 *  The handoff ROLE is deliberately not compared. A reviewer approving flips the same person from
 *  "reviewer" to "merger", which is the responsibility being discharged, not changing hands. */
export function validateMergeConfirm(
  verdict: MergeGateVerdict,
  current: { headSha?: string | null; baseRefName?: string | null },
  confirm?: MergeConfirm | null,
): MergeConfirmCheck {
  if (!confirm) return verdict.requiresConfirm ? "confirm_required" : "ok";
  if (current.headSha && confirm.headSha && confirm.headSha !== current.headSha)
    return "confirm_stale";
  if (current.baseRefName && confirm.baseRefName && confirm.baseRefName !== current.baseRefName)
    return "confirm_stale";
  if (!verdict.requiresConfirm) return "ok";
  // Nobody else was on the hook when the dialog opened, but somebody is now — the operator was
  // never asked to take anything over, so ask rather than treating it as a stale answer.
  if (!confirm.handoff && !confirm.reviewBlockBy) return "confirm_required";
  if (namedDrift(confirm.handoffWho, verdict.handoffWho)) return "confirm_stale";
  if (namedDrift(confirm.reviewBlockBy, verdict.reviewBlockBy)) return "confirm_stale";
  return "ok";
}

/** Parse an untrusted request body's `confirm` field. Returns null for anything that is not a
 *  well-formed confirmation, so a malformed payload is treated as "not confirmed" (and therefore
 *  refused wherever one is required) rather than trusted in part. */
export function parseMergeConfirm(raw: unknown): MergeConfirm | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  const handoff = o.handoff === "reviewer" || o.handoff === "merger" ? o.handoff : null;
  return {
    headSha: str(o.headSha),
    baseRefName: str(o.baseRefName),
    handoff,
    handoffWho: str(o.handoffWho),
    reviewBlockBy: str(o.reviewBlockBy),
  };
}
