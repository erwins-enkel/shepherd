/**
 * Notifications for the sessions of connected machines (issue #3058). Mirrored frames never pass
 * through the EventHub (`sessions.ts`), so `attachPush`/`attachReviewPush` never see them; this
 * listens on the mirror instead and asks `PushService.notify` for the same kinds those raise for a
 * local session — finished, blocked, critic review, login request — tagged with the machine's
 * instance ID. `notify` then reaches only the devices that want relayed notifications and are not
 * registered with that machine themselves, under the same presence, cooldown, reduced-mode and
 * category gates as a local notification.
 *
 * Only live `session:*` frames count. The snapshot a (re)connect takes arrives as
 * `remote:sessions` and is ignored, so nothing that happened while a machine was out of reach is
 * announced late; a machine sends no state frames when the socket opens, only `terminal:owners`.
 * A frame for a session the mirror does not hold raises nothing — that covers the machine's
 * Operator Assistant, which is never in its session list.
 */
import type { BlockReason } from "../blocked";
import { LOGIN_REASON_PUSH_CHARS, type NotifyInput, type PushService } from "../push";
import { isRecord } from "./client";
import type { MirroredSession, RemoteSessionMirror } from "./sessions";

type Notice = Omit<NotifyInput, "sessionId" | "name" | "instanceId" | "hostName">;
type Data = Record<string, unknown>;

/** A critic verdict worth a push: changes requested or a comment, unless the operator dismissed it. */
function reviewNotice(id: string, review: unknown): Notice | null {
  if (!isRecord(review) || review.dismissed) return null;
  const decision = review.decision;
  if (decision !== "changes_requested" && decision !== "commented") return null;
  return { kind: "review", tag: `review:${id}`, decision };
}

/** An agent waiting on the operator to log in for it in the Shared Browser. */
function loginNotice(held: MirroredSession, request: unknown): Notice | null {
  if (!isRecord(request) || typeof request.id !== "string") return null;
  const url = typeof request.url === "string" ? request.url : "";
  const reason = typeof request.reason === "string" ? request.reason : "";
  return {
    kind: "login_request",
    tag: held.id,
    loginHost: URL.canParse(url) ? new URL(url).host : "",
    loginReason: reason.slice(0, LOGIN_REASON_PUSH_CHARS),
    // Per request, as locally — and per machine, since two machines' request IDs may meet.
    cooldownKey: `login_request:${held.host.instanceId}:${request.id}`,
  };
}

/** What each frame asks to announce, read as `attachPush`/`attachReviewPush` read it locally. */
const NOTICES = new Map<string, (data: Data, held: MirroredSession) => Notice | null>([
  ["session:status", (data, { id }) => (data.status === "done" ? { kind: "done", tag: id } : null)],
  [
    "session:block",
    // The machine's own BlockReason; the body copy reads only its `shape`, an unknown one as generic.
    (data, { id }) =>
      isRecord(data.block)
        ? { kind: "blocked", tag: id, reason: data.block as unknown as BlockReason }
        : null,
  ],
  ["session:review", (data, { id }) => reviewNotice(id, data.review)],
  ["session:login-request", (data, held) => loginNotice(held, data.request)],
]);

/** Relay mirrored sessions' notifications through `push`. Returns the unsubscribe. */
export function attachMirrorPush(
  mirror: Pick<RemoteSessionMirror, "subscribe" | "session">,
  push: Pick<PushService, "notify">,
): () => void {
  return mirror.subscribe((event, data) => {
    const read = NOTICES.get(event);
    if (!read || !isRecord(data) || typeof data.id !== "string") return;
    const held = mirror.session(data.id);
    const found = held && read(data, held);
    if (!found) return;
    push
      .notify({
        ...found,
        sessionId: held.id,
        name: typeof held.name === "string" ? held.name : held.id,
        instanceId: held.host.instanceId,
        hostName: held.host.name,
      })
      .catch((err) => console.warn(`[push] relayed ${found.kind} notify failed:`, err));
  });
}
