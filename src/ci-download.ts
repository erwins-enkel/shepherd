/**
 * `ci_download`: GitHub Actions logs and artifacts for egress-confined agents, with no new
 * allowlist entries.
 *
 * `gh run download` / `gh run view --log*` redirect from `api.github.com` to Actions blob storage
 * (`productionresultssa<N>.blob.core.windows.net`, `results-receiver.actions.githubusercontent.com`),
 * which the autonomous egress firewall blocks — and allowing them means 200 shared-IP Azure hosts.
 * Instead the (unsandboxed) server fetches the bytes and places them in the session's worktree
 * under `.shepherd-ci/run-<runId>/`. Artifacts land as their raw zip: the server never extracts
 * untrusted archives; the agent unzips inside its sandbox.
 *
 * The worktree is agent-writable, so placement never resolves a path string under it after the
 * first open: each directory is opened `O_DIRECTORY|O_NOFOLLOW` relative to its held parent fd
 * (`/proc/self/fd/<fd>/<name>`), and the file is created `O_EXCL|O_NOFOLLOW` there. A component
 * swapped for a symlink mid-call can't redirect the write. Linux-only — so is the egress backend
 * this tool exists for.
 *
 * Downloads can outlast Claude Code's 60s HTTP MCP cap, so a call waits at most `waitMs` and then
 * answers `pending`; the agent re-calls with the same arguments to keep waiting.
 */
import { constants as fsConstants } from "node:fs";
import { mkdir, mkdtemp, open, rm, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { sanitizeDetail } from "./forge/gh-attempt";
import type { ForgeRunArtifact, GitForge } from "./forge/types";
import { redactSecretText } from "./redact";
import { fenceUntrusted } from "./untrusted";

/** Largest artifact fetched (checked against the API size, then enforced while streaming). */
export const CI_ARTIFACT_MAX_BYTES = 512 * 1024 * 1024;
/** Worktree dir the files land in; `.shepherd-*` is git-excluded by src/shepherd-exclude.ts. */
const CI_DOWNLOAD_DIR = ".shepherd-ci";
/** One call's wait window — under Claude Code's 60s HTTP MCP abort. */
const WAIT_MS = 45_000;
/** A finished download nobody re-called for is dropped after this, so a later identical call
 *  (a re-run of the same run id, a deleted `.shepherd-ci/`) fetches fresh. */
const RETENTION_MS = 10 * 60_000;
const ARTIFACT_NAME_MAX = 256;
const COPY_CHUNK = 1024 * 1024;

export type CiDownloadTarget =
  { kind: "artifact"; name: string } | { kind: "job"; jobId: number } | { kind: "failed" };

export interface CiDownloadArgs {
  runId: number;
  target: CiDownloadTarget;
}

export type CiDownloadData =
  { status: "done"; path: string; bytes: number } | { status: "pending"; message: string };

/** Structurally an `ApplyResult` (src/agent-control.ts imports this module, not vice versa). */
export type CiDownloadResult =
  { ok: true; data: CiDownloadData } | { ok: false; status: number; error: string };

export type CiDownloadForge = Pick<
  GitForge,
  "slug" | "listRunArtifacts" | "runLogText" | "downloadArtifactZip"
>;

export interface CiDownloadSession {
  id: string;
  repoPath: string;
  worktreePath: string;
}

export interface CiDownloadDeps {
  forgeFor(repoPath: string): CiDownloadForge | null;
  /** Server-private staging root (never inside a worktree); default `~/.shepherd/ci-download`. */
  tmpRoot?: string;
  waitMs?: number;
  /** How long an unclaimed finished download answers a re-call; default 10 min. */
  retentionMs?: number;
  now?: () => number;
  /** Test seam: runs after the run dir's fd is held, before the file is created. */
  beforeWrite?: () => void | Promise<void>;
}

/** A refusal the agent should read as-is (bad args, not found, too large, expired). */
class CiDownloadError extends Error {}

function positiveInt(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
}

/** Validate raw tool arguments: `runId`, plus at most one of `artifact` / `jobId`. */
export function parseCiDownloadArgs(raw: Record<string, unknown>): CiDownloadArgs | string {
  const runId = positiveInt(raw.runId);
  if (runId === null) return "runId must be a positive integer";
  const hasArtifact = raw.artifact !== undefined;
  const hasJob = raw.jobId !== undefined;
  if (hasArtifact && hasJob) return "pass at most one of artifact and jobId";
  if (hasArtifact) {
    const name = raw.artifact;
    if (typeof name !== "string" || name.trim() === "" || name.length > ARTIFACT_NAME_MAX) {
      return `artifact must be a non-empty name of at most ${ARTIFACT_NAME_MAX} chars`;
    }
    return { runId, target: { kind: "artifact", name } };
  }
  if (hasJob) {
    const jobId = positiveInt(raw.jobId);
    if (jobId === null) return "jobId must be a positive integer";
    return { runId, target: { kind: "job", jobId } };
  }
  return { runId, target: { kind: "failed" } };
}

function targetKey(a: CiDownloadArgs): string {
  const t = a.target;
  const tail = t.kind === "artifact" ? `a:${t.name}` : t.kind === "job" ? `j:${t.jobId}` : "f";
  return `${a.runId}|${tail}`;
}

/** The artifact list an unknown-name error shows; names come from the repo's CI config. */
function describeArtifacts(list: ForgeRunArtifact[]): string {
  if (list.length === 0) return "this run has no artifacts";
  const lines = list.map((a) => `${a.name} (${a.sizeBytes} bytes${a.expired ? ", expired" : ""})`);
  return `available artifacts:\n${fenceUntrusted("artifact-names", lines.join("\n"))}`;
}

/** Fetch the target into `tmpFile`; returns the file name it gets in the run dir. */
async function fetchTarget(
  forge: CiDownloadForge,
  args: CiDownloadArgs,
  tmpFile: string,
): Promise<string> {
  const t = args.target;
  if (t.kind === "artifact") {
    if (!forge.listRunArtifacts || !forge.downloadArtifactZip) {
      throw new CiDownloadError("artifact downloads need a GitHub repo");
    }
    const list = await forge.listRunArtifacts(args.runId);
    const hit = list.find((a) => a.name === t.name);
    if (!hit) throw new CiDownloadError(`no artifact with that name; ${describeArtifacts(list)}`);
    if (hit.expired) throw new CiDownloadError("that artifact has expired");
    if (hit.sizeBytes > CI_ARTIFACT_MAX_BYTES) {
      throw new CiDownloadError(
        `artifact is ${hit.sizeBytes} bytes, over the ${CI_ARTIFACT_MAX_BYTES}-byte cap`,
      );
    }
    await forge.downloadArtifactZip(hit.id, tmpFile, { maxBytes: CI_ARTIFACT_MAX_BYTES });
    return `artifact-${hit.id}.zip`;
  }
  if (!forge.runLogText) throw new CiDownloadError("log downloads need a GitHub repo");
  const jobId = t.kind === "job" ? t.jobId : undefined;
  const text = await forge.runLogText(args.runId, { jobId });
  await writeFile(tmpFile, redactSecretText(text), { flag: "wx", mode: 0o600 });
  return jobId === undefined ? "failed.log" : `job-${jobId}.log`;
}

/** The message an unexpected failure reports: a 404 named plainly, else gh's first words. */
function failureMessage(e: unknown, slug: string | null): string {
  if (e instanceof CiDownloadError) return e.message;
  const raw = String((e as { stderr?: unknown })?.stderr || (e as Error)?.message || e);
  if (/HTTP 404|Not Found/i.test(raw)) {
    return `not found in ${slug ?? "this repo"} (check runId / jobId, and that the run belongs to this repo)`;
  }
  if (/too large|maxBuffer/i.test(raw)) {
    return "log too large to fetch whole; pass jobId for a single job's log";
  }
  return `download failed: ${sanitizeDetail(raw)}`;
}

async function openSubdir(parent: FileHandle, name: string): Promise<FileHandle> {
  const path = `/proc/self/fd/${parent.fd}/${name}`;
  await mkdir(path).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "EEXIST") throw e;
  });
  try {
    return await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR") {
      throw new CiDownloadError(`${name} in the worktree is not a real directory; remove it`);
    }
    throw e;
  }
}

async function copyInto(src: string, dest: FileHandle): Promise<number> {
  const input = await open(src, fsConstants.O_RDONLY);
  try {
    const buf = Buffer.allocUnsafe(COPY_CHUNK);
    let total = 0;
    for (;;) {
      const { bytesRead } = await input.read(buf, 0, COPY_CHUNK, null);
      if (bytesRead === 0) return total;
      let off = 0;
      while (off < bytesRead) {
        const { bytesWritten } = await dest.write(buf, off, bytesRead - off, null);
        off += bytesWritten;
      }
      total += bytesRead;
    }
  } finally {
    await input.close();
  }
}

/**
 * Copy `srcFile` to `<worktree>/.shepherd-ci/run-<runId>/<fileName>` through held directory fds
 * (see the module doc). A planted symlink at the file name is unlinked (only the link goes); a
 * symlinked directory component is refused. Returns the bytes written.
 */
export async function placeIntoWorktree(
  worktreePath: string,
  runId: number,
  fileName: string,
  srcFile: string,
  beforeWrite?: () => void | Promise<void>,
): Promise<number> {
  const held: FileHandle[] = [];
  try {
    const root = await open(worktreePath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    held.push(root);
    const ci = await openSubdir(root, CI_DOWNLOAD_DIR);
    held.push(ci);
    const runDir = await openSubdir(ci, `run-${runId}`);
    held.push(runDir);
    await beforeWrite?.();
    const target = `/proc/self/fd/${runDir.fd}/${fileName}`;
    await unlink(target).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
    });
    const out = await open(
      target,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o644,
    ).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "EEXIST" || e.code === "ELOOP") {
        throw new CiDownloadError(`${fileName} was replaced while writing; retry`);
      }
      throw e;
    });
    held.push(out);
    if (!(await out.stat()).isFile())
      throw new CiDownloadError(`${fileName} is not a regular file`);
    return await copyInto(srcFile, out);
  } finally {
    // best-effort: a failed close leaks nothing the result depends on.
    for (const h of held.reverse()) await h.close().catch(() => {});
  }
}

interface Job {
  key: string;
  promise: Promise<CiDownloadResult>;
  result: CiDownloadResult | null;
  settledAt: number | null;
}

/** The per-session download broker: one in-flight download per session, long-polled. */
export class CiDownloads {
  readonly #jobs = new Map<string, Job>();

  constructor(private readonly deps: CiDownloadDeps) {}

  async request(
    session: CiDownloadSession,
    raw: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CiDownloadResult> {
    const args = parseCiDownloadArgs(raw);
    if (typeof args === "string") return { ok: false, status: 400, error: args };
    if (process.platform !== "linux") {
      return { ok: false, status: 501, error: "ci_download is only available on Linux hosts" };
    }
    const key = targetKey(args);
    const now = this.deps.now ?? Date.now;
    let job = this.#jobs.get(session.id);
    const expired =
      job?.settledAt != null && now() - job.settledAt > (this.deps.retentionMs ?? RETENTION_MS);
    if (expired) job = undefined;
    if (job && job.key !== key) {
      if (!job.result) {
        return {
          ok: false,
          status: 409,
          error: "another ci_download is still running for this session; re-call it to wait first",
        };
      }
      job = undefined;
    }
    if (!job) {
      const promise = this.#run(session, args);
      const fresh: Job = { key, promise, result: null, settledAt: null };
      void promise.then((r) => {
        fresh.result = r;
        fresh.settledAt = now();
      });
      this.#jobs.set(session.id, fresh);
      job = fresh;
    }
    const result = job.result ?? (await this.#wait(job.promise, signal));
    if (result && this.#jobs.get(session.id) === job) this.#jobs.delete(session.id);
    return (
      result ?? {
        ok: true,
        data: {
          status: "pending",
          message:
            "Still downloading. Call ci_download again with the same arguments to keep waiting.",
        },
      }
    );
  }

  /** The job's result if it settles within the wait window, else null. */
  async #wait(
    promise: Promise<CiDownloadResult>,
    signal?: AbortSignal,
  ): Promise<CiDownloadResult | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const elapsed = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.deps.waitMs ?? WAIT_MS);
      onAbort = () => resolve(null);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([promise, elapsed]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  async #run(session: CiDownloadSession, args: CiDownloadArgs): Promise<CiDownloadResult> {
    const forge = this.deps.forgeFor(session.repoPath);
    if (!forge?.slug) return { ok: false, status: 400, error: "ci_download needs a GitHub repo" };
    const root = this.deps.tmpRoot ?? join(homedir(), ".shepherd", "ci-download");
    let staging: string | null = null;
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      staging = await mkdtemp(join(root, "dl-"));
      const tmpFile = join(staging, "payload");
      const fileName = await fetchTarget(forge, args, tmpFile);
      const bytes = await placeIntoWorktree(
        session.worktreePath,
        args.runId,
        fileName,
        tmpFile,
        this.deps.beforeWrite,
      );
      const path = join(session.worktreePath, CI_DOWNLOAD_DIR, `run-${args.runId}`, fileName);
      return { ok: true, data: { status: "done", path, bytes } };
    } catch (e) {
      const status = e instanceof CiDownloadError ? 400 : 502;
      return { ok: false, status, error: failureMessage(e, forge.slug) };
    } finally {
      // best-effort: a leftover staging dir is server-private and harmless.
      if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }
}
