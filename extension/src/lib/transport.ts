import { formatContextBlock } from "./context-block";
import {
  TransportError,
  type CaptureConfig,
  type PageMetadata,
  type TransportErrorKind,
} from "./types";
import type { CapturedSignals } from "./signals";

export type FetchFn = (input: string, init: any) => Promise<Response>;

/** Issue title / body caps — mirror the server's POST /api/issues limits so the
 *  popup can pre-validate and show a clear message instead of a generic 'invalid'.
 *  The server stays the authority; these only drive client-side UX. */
export const MAX_ISSUE_TITLE_LEN = 200;
export const MAX_ISSUE_BODY_LEN = 16000;

/**
 * Compose the issue body sent to POST /api/issues: the user's prompt plus the
 * fenced metadata/signals context block. Exported so the popup pre-validates the
 * exact string fileIssue() sends — one source of truth, no length-check drift.
 */
export function composeIssueBody(
  prompt: string,
  metadata: PageMetadata,
  signals?: CapturedSignals,
): string {
  return `${prompt}\n\n${formatContextBlock(metadata, signals)}`;
}

interface SpawnInput {
  prompt: string;
  metadata: PageMetadata;
  /** Present only when a screenshot was captured. */
  screenshot?: Blob;
  /** When false (or no screenshot), skip /api/uploads and send images:[]. */
  attachScreenshot: boolean;
  signals?: CapturedSignals;
  /** Routing-resolved effective repo; overrides `config.repoPath` at spawn. */
  repoPath: string;
}

function kindForStatus(status: number): TransportErrorKind {
  if (status === 403) return "origin";
  if (status === 401) return "auth";
  if (status === 413) return "too_large";
  // 415 is overloaded server-side: uploads → unsupported image type, sessions →
  // wrong Content-Type. `err_unsupported` ("screenshot format…") only fits the
  // uploads case, which is the only one reachable here because createSession()
  // always sends `application/json` (see its header below). If that ever stops
  // being true, a sessions-415 would surface a misleading message — keep the
  // Content-Type fixed, or split this kind by request.
  if (status === 415) return "unsupported";
  // 400 is any validation rejection (bad branch, oversized prompt, repo-path
  // confinement, missing upload field, …) — too varied for a fixed message, so
  // the popup shows the server's `detail` for this kind.
  if (status === 400) return "invalid";
  return "unknown";
}

function authHeaders(token: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function ensureOk(res: Response): Promise<void> {
  if (res.ok) return;
  let detail = "";
  try {
    const body = (await res.json()) as { error?: string };
    detail = body.error ?? "";
  } catch {
    /* ignore non-JSON bodies */
  }
  throw new TransportError(kindForStatus(res.status), res.status, detail || `HTTP ${res.status}`);
}

/**
 * Probe POST /api/ping to verify the configured base URL + token reach a
 * Shepherd core that accepts this origin. Resolves on 2xx; otherwise the
 * response maps via the shared `kindForStatus` (403→origin, 401→auth, …) and a
 * network failure becomes `unreachable` — the same classification the popup
 * shows. Used by the options/popup connection-status UX.
 */
export async function ping(fetchFn: FetchFn, config: CaptureConfig): Promise<void> {
  let res: Response;
  try {
    res = await fetchFn(`${config.baseUrl}/api/ping`, {
      method: "POST",
      headers: authHeaders(config.token),
    });
  } catch {
    throw new TransportError("unreachable", null, "could not reach Shepherd");
  }
  await ensureOk(res);
}

/** POST the PNG to /api/uploads; return the confined staging path. */
async function uploadScreenshot(
  fetchFn: FetchFn,
  config: CaptureConfig,
  screenshot: Blob,
): Promise<string> {
  const form = new FormData();
  form.append("file", screenshot, "capture.png");
  let res: Response;
  try {
    res = await fetchFn(`${config.baseUrl}/api/uploads`, {
      method: "POST",
      headers: authHeaders(config.token),
      body: form,
    });
  } catch {
    throw new TransportError("unreachable", null, "could not reach Shepherd");
  }
  await ensureOk(res);
  const body = (await res.json()) as { path?: string };
  if (!body.path) throw new TransportError("unknown", res.status, "upload returned no path");
  return body.path;
}

/** POST /api/sessions with the staged image + composed prompt; return desig. */
async function createSession(
  fetchFn: FetchFn,
  config: CaptureConfig,
  repoPath: string,
  prompt: string,
  images: string[],
): Promise<string> {
  const payload: Record<string, unknown> = {
    repoPath,
    baseBranch: config.baseBranch,
    prompt,
    images,
  };
  if (config.model !== "default") payload.model = config.model;

  let res: Response;
  try {
    res = await fetchFn(`${config.baseUrl}/api/sessions`, {
      method: "POST",
      // Must stay application/json: the server returns 415 for a wrong
      // Content-Type, which kindForStatus() maps to the uploads-flavored
      // `err_unsupported` message. See the 415 note there.
      headers: { "Content-Type": "application/json", ...authHeaders(config.token) },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new TransportError("unreachable", null, "could not reach Shepherd");
  }
  await ensureOk(res);
  const body = (await res.json()) as { desig?: string };
  if (!body.desig) throw new TransportError("unknown", res.status, "session returned no desig");
  return body.desig;
}

/**
 * Spawn-now: optionally stage the screenshot, then create a session whose prompt
 * is the user text plus the fenced metadata + signals context block. When the
 * screenshot is not attached, no upload happens and `images` is empty.
 */
export async function spawnNow(
  fetchFn: FetchFn,
  config: CaptureConfig,
  input: SpawnInput,
): Promise<string> {
  const images: string[] = [];
  if (input.attachScreenshot && input.screenshot) {
    images.push(await uploadScreenshot(fetchFn, config, input.screenshot));
  }
  const prompt = `${input.prompt}\n\n${formatContextBlock(input.metadata, input.signals)}`;
  return createSession(fetchFn, config, input.repoPath, prompt, images);
}

/** File the capture as a GitHub/Gitea issue: title + (prompt + context block) body.
 *  No screenshot upload — a remote issue can't reference the confined local path. */
export async function fileIssue(
  fetchFn: FetchFn,
  config: CaptureConfig,
  input: {
    repoPath: string;
    title: string;
    prompt: string;
    metadata: PageMetadata;
    signals?: CapturedSignals;
  },
): Promise<{ number: number; url: string }> {
  const body = composeIssueBody(input.prompt, input.metadata, input.signals);

  let res: Response;
  try {
    res = await fetchFn(`${config.baseUrl}/api/issues`, {
      method: "POST",
      // Same fixed application/json as createSession — see the 415 note there.
      headers: { "Content-Type": "application/json", ...authHeaders(config.token) },
      body: JSON.stringify({ repo: input.repoPath, title: input.title, body }),
    });
  } catch {
    throw new TransportError("unreachable", null, "could not reach Shepherd");
  }
  await ensureOk(res);
  const parsed = (await res.json()) as { number?: number; url?: string };
  if (parsed.number === undefined || !parsed.url) {
    throw new TransportError("unknown", res.status, "issue returned no number/url");
  }
  return { number: parsed.number, url: parsed.url };
}
