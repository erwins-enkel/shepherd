// #3016: the herd's note on a session whose PR its epic integrated — merged work, not active epic
// work. A local one only says so; one on another machine also says how its settle there stands
// and what, if anything, the operator can do about it.
import { m } from "#lib/paraglide/messages.js";
import type {
  DrainStatus,
  RemoteSettlePending,
  RemoteSettleReason,
  SessionHost,
} from "#lib/types.js";
import type { TooltipExplanation } from "#lib/tooltips/content.js";

/** The integrated work a note describes (see `IntegratedNote` in epic-grouping.ts). */
export interface IntegratedNoteInput {
  parentIssueNumber: number;
  host: SessionHost | null;
  /** Why its settle on `host` is still open; null when nothing is known to be open. */
  settle: RemoteSettleReason | null;
}

/** Reasons the operator has to act on: shown in the warn tone, the others in the quiet one. */
const NEEDS_OPERATOR: ReadonlySet<RemoteSettleReason> = new Set([
  "held",
  "not_merged_there",
  "rejected",
  "unsupported",
]);

export function integratedNoteTone(note: IntegratedNoteInput): "warn" | "quiet" {
  return note.settle && NEEDS_OPERATOR.has(note.settle) ? "warn" : "quiet";
}

/** A reason the client may not know yet (an open enum) reads as an ongoing settle. */
function known(reason: RemoteSettleReason | null): RemoteSettleReason {
  switch (reason) {
    case "offline":
    case "busy":
    case "held":
    case "not_merged_there":
    case "rejected":
    case "unsupported":
    case "failed":
      return reason;
    default:
      return "requested";
  }
}

function statusLabel(reason: RemoteSettleReason): string {
  switch (reason) {
    case "offline":
      return m.integrated_offline_status();
    case "busy":
      return m.integrated_busy_status();
    case "held":
      return m.integrated_held_status();
    case "not_merged_there":
      return m.integrated_not_merged_there_status();
    case "rejected":
      return m.integrated_rejected_status();
    case "unsupported":
      return m.integrated_unsupported_status();
    case "failed":
      return m.integrated_failed_status();
    default:
      return m.integrated_requested_status();
  }
}

function happens(reason: RemoteSettleReason, host: string): string {
  switch (reason) {
    case "offline":
      return m.integrated_offline_happens({ host });
    case "busy":
      return m.integrated_busy_happens({ host });
    case "held":
      return m.integrated_held_happens({ host });
    case "not_merged_there":
      return m.integrated_not_merged_there_happens({ host });
    case "rejected":
      return m.integrated_rejected_happens({ host });
    case "unsupported":
      return m.integrated_unsupported_happens({ host });
    case "failed":
      return m.integrated_failed_happens({ host });
    default:
      return m.integrated_requested_happens({ host });
  }
}

function todo(reason: RemoteSettleReason, host: string): string {
  switch (reason) {
    case "offline":
      return m.integrated_offline_todo({ host });
    case "busy":
      return m.integrated_busy_todo({ host });
    case "held":
      return m.integrated_held_todo({ host });
    case "not_merged_there":
      return m.integrated_not_merged_there_todo();
    case "rejected":
      return m.integrated_rejected_todo({ host });
    case "unsupported":
      return m.integrated_unsupported_todo({ host });
    case "failed":
      return m.integrated_failed_todo();
    default:
      return m.integrated_requested_todo({ host });
  }
}

/** The chip's text. */
export function integratedNoteLabel(note: IntegratedNoteInput): string {
  const parent = String(note.parentIssueNumber);
  if (!note.host) return m.integrated_chip({ parent });
  return m.integrated_chip_remote({
    parent,
    host: note.host.name,
    status: statusLabel(known(note.settle)),
  });
}

/** The chip's explanation: what happened, what happens now, and what the operator can do. */
export function integratedNoteExplanation(note: IntegratedNoteInput): TooltipExplanation {
  const title = m.integrated_tip_title({ parent: String(note.parentIssueNumber) });
  if (!note.host)
    return {
      title,
      summary: m.integrated_tip_summary_local(),
      sections: [
        { label: m.integrated_tip_happens(), text: m.integrated_local_happens() },
        { label: m.integrated_tip_todo(), text: m.integrated_local_todo() },
      ],
    };
  const host = note.host.name;
  const reason = known(note.settle);
  return {
    title,
    summary: m.integrated_tip_summary_remote({ host }),
    sections: [
      { label: m.integrated_tip_happens(), text: happens(reason, host) },
      { label: m.integrated_tip_todo(), text: todo(reason, host) },
    ],
  };
}

/** #3016: an open settle as the herd lists it — keyed by its session there. */
export interface PendingSettle extends RemoteSettlePending {
  /** This Shepherd's checkout of the repo whose drain reports it. */
  repoPath: string;
}

/** #3016: every open settle the repos' drain statuses report, by session id. They outlive the
 *  epic's record, which the herd drops once every child is merged. */
export function pendingSettles(
  drain: Readonly<Record<string, DrainStatus>>,
): Map<string, PendingSettle> {
  const out = new Map<string, PendingSettle>();
  for (const [repoPath, status] of Object.entries(drain))
    for (const p of status.remoteSettle ?? []) out.set(p.sessionId, { ...p, repoPath });
  return out;
}

/** #3016: the note for session `id`: what epic grouping noted (integrated work of an active epic),
 *  with the drain's open settle filling in what it knows — or the drain's alone once the epic's
 *  record is gone. */
export function settleNoteFor(
  id: string,
  grouped: IntegratedNoteInput | undefined,
  settles: ReadonlyMap<string, PendingSettle>,
): IntegratedNoteInput | undefined {
  const open = settles.get(id);
  if (!open) return grouped;
  return {
    parentIssueNumber: grouped?.parentIssueNumber ?? open.parentIssueNumber,
    host: grouped?.host ?? open.host,
    settle: grouped?.settle ?? open.reason,
  };
}

/** #3016: the open settles no listed row carries — their session is not in this Shepherd's mirror
 *  (not loaded yet, or gone there) — within the herd's repo filter (empty = all). */
export function unlistedSettles(
  settles: ReadonlyMap<string, PendingSettle>,
  mirroredIds: ReadonlySet<string>,
  repoFilter: ReadonlySet<string>,
): PendingSettle[] {
  return [...settles.values()].filter(
    (p) => !mirroredIds.has(p.sessionId) && (repoFilter.size === 0 || repoFilter.has(p.repoPath)),
  );
}
