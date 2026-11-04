import { ApiError, PlacementRefusedError } from "#lib/api.js";
import { cloneFailureText } from "#lib/clone-errors.js";
import { m } from "#lib/paraglide/messages.js";
import { placementRefusalText } from "#lib/placement.js";
import { platformName } from "#lib/remote-sessions.js";
import type { RemoteInstance } from "#lib/types.js";

/**
 * "Run on" in the New Task dialog (#2763): Automatic — the server chooses the machine (#2772) —,
 * this machine, or a connected machine; and what the dialog says when the task could not start
 * there. The field exists only while a machine is connected, so without machines the dialog is
 * exactly what it was.
 */

/** Connected machines released for tasks: a Windows machine is listed in Settings but never
 *  offered here (#2770), so with only such a machine connected the dialog stays unchanged. */
export function connectedMachines(machines: readonly RemoteInstance[]): RemoteInstance[] {
  return machines.filter((machine) => machine.status === "connected" && machine.released);
}

/** The machines a task for this project can start on: connected and released. One without a
 *  checkout of the project (its forge slug) clones it first (`needsClone`). A repo without a slug
 *  can be neither matched nor cloned on another machine. */
export function runOnMachines(
  machines: readonly RemoteInstance[],
  slug: string | undefined,
): RemoteInstance[] {
  if (!slug) return [];
  return connectedMachines(machines);
}

/** The machine has no checkout of the project yet: a task sent there clones it first. */
export function needsClone(machine: RemoteInstance | undefined, slug: string | undefined): boolean {
  return !!machine && !!slug && !(machine.projects?.includes(slug) ?? false);
}

/** "MacBook (macOS)", and "· clones first" after it when the project is cloned there first. */
export function machineLabel(machine: RemoteInstance, clone = false): string {
  const label = machine.info
    ? m.newtask_runon_machine({
        machine: machine.name,
        platform: platformName(machine.info.platform),
      })
    : machine.name;
  return clone ? m.newtask_runon_machine_clone({ machine: label }) : label;
}

/** A send to a machine that went unanswered — it may have started there. Only then does the next
 *  attempt reuse the key: the server sends the same dispatch again and it never starts twice. A
 *  network failure on the way to this Shepherd counts too: the request may have gone through. */
export function isUnansweredSend(err: unknown): boolean {
  if (err instanceof ApiError) return err.code === "remote_dispatch_unknown";
  return err instanceof TypeError;
}

export interface PendingSend {
  key: string;
  /** The task as it was sent, serialized — a changed task is a new submission. */
  payload: string;
}

/** The Idempotency-Key for this send: the unanswered one's again while the task is unchanged, so a
 *  retry is the same dispatch; otherwise a fresh one. */
export function dispatchKeyFor(
  pending: PendingSend | null,
  payload: string,
  fresh: () => string = () => crypto.randomUUID(),
): string {
  return pending?.payload === payload ? pending.key : fresh();
}

/** One attempt of a task while the machine choice is active (#2772): its key and the task as sent.
 *  Every such create is keyed — wherever it lands, a send to another machine can go unanswered.
 *  The key is the unanswered one's again while the task is unchanged; the spawn id is per attempt,
 *  so it is not part of the task. Null when the choice is not active: no key, as before. */
export function keyedSend(
  keyed: boolean,
  pending: PendingSend | null,
  input: object,
): PendingSend | null {
  if (!keyed) return null;
  const payload = JSON.stringify({ ...input, spawnId: undefined });
  return { key: dispatchKeyFor(pending, payload), payload };
}

/** What the next attempt may reuse after `send` failed with `err`: only an unanswered send. */
export function pendingAfter(send: PendingSend | null, err: unknown): PendingSend | null {
  return send && isUnansweredSend(err) ? { key: send.key, payload: send.payload } : null;
}

/** What the dialog says when the machine choice refused the task (#2772) — no machine fits, the
 *  one it is meant for is out of reach, or the named one lacks a requirement — or null. */
export function placementFailureMessage(err: unknown): string | null {
  return err instanceof PlacementRefusedError ? placementRefusalText(err.refusal) : null;
}

/** What the dialog says when `machine` could not start the task, or null when the failure is not
 *  about the machine (the dialog's generic message applies). */
export function runOnFailureMessage(err: unknown, machine: string): string | null {
  if (isUnansweredSend(err)) return m.newtask_runon_unknown({ machine });
  if (!(err instanceof ApiError)) return null;
  switch (err.code) {
    case "remote_rejected":
      return m.newtask_runon_rejected({ machine, reason: err.message });
    case "remote_upload_failed":
      return m.newtask_runon_upload_failed({ machine, reason: err.message });
    case "remote_clone_failed":
      // `message` is the machine's clone error code (`clonerepo_failed_auth`, …).
      return m.newtask_runon_clone_failed({ machine, reason: cloneFailureText(err.message) });
    case "remote_target_unavailable":
      return m.newtask_runon_unavailable({ machine });
    case "remote_target_unreleased":
      return m.newtask_runon_unreleased({ machine });
    case "remote_project_missing":
      return m.newtask_runon_project_missing({ machine });
    case "remote_target_unknown":
      return m.newtask_runon_gone({ machine });
    case "remote_project_unknown":
      return m.newtask_runon_project_unknown();
    default:
      return null;
  }
}
