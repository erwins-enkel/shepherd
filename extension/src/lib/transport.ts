import { formatContextBlock } from "./context-block";
import {
  TransportError,
  type CaptureConfig,
  type PageMetadata,
  type TransportErrorKind,
} from "./types";

export type FetchFn = (input: string, init: any) => Promise<Response>;

interface SpawnInput {
  prompt: string;
  metadata: PageMetadata;
  screenshot: Blob;
}

function kindForStatus(status: number): TransportErrorKind {
  if (status === 403) return "origin";
  if (status === 401) return "auth";
  if (status === 413) return "too_large";
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
  prompt: string,
  imagePath: string,
): Promise<string> {
  const payload: Record<string, unknown> = {
    repoPath: config.repoPath,
    baseBranch: config.baseBranch,
    prompt,
    images: [imagePath],
  };
  if (config.model !== "default") payload.model = config.model;

  let res: Response;
  try {
    res = await fetchFn(`${config.baseUrl}/api/sessions`, {
      method: "POST",
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
 * Spawn-now: stage the screenshot, then create a session whose prompt is the
 * user text plus the fenced metadata context block. Returns the desig.
 */
export async function spawnNow(
  fetchFn: FetchFn,
  config: CaptureConfig,
  input: SpawnInput,
): Promise<string> {
  const path = await uploadScreenshot(fetchFn, config, input.screenshot);
  const prompt = `${input.prompt}\n\n${formatContextBlock(input.metadata)}`;
  return createSession(fetchFn, config, prompt, path);
}
