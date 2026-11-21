/**
 * Stream one GitHub Actions artifact's zip to a server-private file (`ci_download`).
 *
 * `gh api repos/<slug>/actions/artifacts/<id>/zip` answers with a 302 to Actions blob storage;
 * gh follows it from the (unsandboxed) server, so sandboxed agents never need those hosts. The
 * shared `GhRunner` buffers stdout as a string, so this binary download spawns its own `gh`
 * and streams stdout to `destFile` under a byte cap. It honours (and feeds) the REST read
 * backoff like a runner call would. The zip is never extracted here.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { isRateLimitError, parseRetryAfter, restRateLimit } from "./rate-limit";

/** A hung download can't hold the server forever. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const STDERR_MAX = 4096;

export interface ArtifactDownloadDeps {
  spawn?: typeof nodeSpawn;
  /** REST read backoff tracker; default the process-wide one. */
  rest?: Pick<typeof restRateLimit, "blocked" | "noteLimitError" | "snapshot">;
  timeoutMs?: number;
}

/** Thrown when the stream passes `maxBytes`; the partial file is the caller's to remove. */
export class ArtifactTooLarge extends Error {}

/** Download artifact `artifactId` of `slug` into `destFile` (created exclusively, 0600).
 *  Resolves with the byte count; rejects on a gh failure, the byte cap, timeout or abort. */
export async function downloadGithubArtifactZip(
  slug: string,
  artifactId: number,
  destFile: string,
  o: { maxBytes: number; signal?: AbortSignal },
  deps: ArtifactDownloadDeps = {},
): Promise<number> {
  const rest = deps.rest ?? restRateLimit;
  if (rest.blocked()) {
    const until = new Date(rest.snapshot().pausedUntil ?? 0).toISOString();
    const stderr = `REST API rate limit backoff active until ${until}; artifact download skipped`;
    throw Object.assign(new Error(stderr), { stderr });
  }
  const out = createWriteStream(destFile, { flags: "wx", mode: 0o600 });
  await new Promise<void>((resolve, reject) => {
    out.once("open", () => resolve());
    out.once("error", reject);
  });
  const child = (deps.spawn ?? nodeSpawn)(
    "gh",
    ["api", `repos/${slug}/actions/artifacts/${artifactId}/zip`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  return new Promise<number>((resolve, reject) => {
    let bytes = 0;
    let stderr = "";
    let failure: Error | null = null;
    const fail = (e: Error) => {
      failure ??= e;
      child.kill("SIGKILL");
      // Drain whatever is buffered so the pipe can end and `close` fires.
      child.stdout?.resume();
    };
    // A write error (disk full) after the open must not go unhandled.
    out.on("error", (e) => fail(e));
    const timer = setTimeout(
      () => fail(new Error("artifact download timed out")),
      deps.timeoutMs ?? DOWNLOAD_TIMEOUT_MS,
    );
    const onAbort = () => fail(new Error("artifact download aborted"));
    o.signal?.addEventListener("abort", onAbort, { once: true });
    if (o.signal?.aborted) onAbort();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > o.maxBytes) {
        fail(new ArtifactTooLarge(`artifact exceeds ${o.maxBytes} bytes`));
        return;
      }
      if (!out.write(chunk)) {
        child.stdout?.pause();
        out.once("drain", () => {
          if (!failure) child.stdout?.resume();
        });
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < STDERR_MAX) stderr += chunk.toString().slice(0, STDERR_MAX);
    });
    child.once("error", (e) => fail(e));
    child.once("close", (code) => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      out.end(() => {
        if (failure) return reject(failure);
        if (code !== 0) {
          const err = Object.assign(new Error(`gh exited ${code}: ${stderr.trim()}`), { stderr });
          if (isRateLimitError(err)) rest.noteLimitError(parseRetryAfter(stderr), "artifact zip");
          return reject(err);
        }
        resolve(bytes);
      });
    });
  });
}
