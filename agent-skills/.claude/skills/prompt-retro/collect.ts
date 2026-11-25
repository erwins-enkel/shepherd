/**
 * /prompt-retro data collector (#4152): reads the operator's archived sessions through the
 * `shepherd` CLI and reduces them to a compact digest the skill reasons over. Deterministic
 * reduction lives here; clustering and judgement stay in SKILL.md.
 *
 *   bun collect.ts [--limit N] [--repo <path> | --all-repos] [--profile <name>]
 *
 * Prints the digest JSON on stdout. CLI exit 3/4/7 (unauthenticated, scope, unreachable) is passed
 * through with a one-line reason on stderr. Prompt and steer text is copied verbatim: it is
 * untrusted data for whoever reads the digest.
 */
import { dirname } from "node:path";

export interface RetroSession {
  id: string;
  desig: string;
  prompt: string;
  repoPath: string;
  auto: boolean;
  issueNumber: number | null;
  scheduleId: string | null;
  /** A Fix-PR session: Shepherd composed its prompt. */
  landingRepair?: boolean;
  terminal: boolean;
  archiveReason: string | null;
  createdAt: number;
  settledAt: number | null;
  archivedAt: number | null;
}

export interface RetroMessage {
  role: string;
  text: string;
  ts: number;
  /** Set on user messages Shepherd typed, by src/steer-log.ts; absent on the operator's own. */
  steer?: string;
  /** The transcript's first message, when it is the opening prompt. */
  initial?: boolean;
}

export interface RetroMessages {
  messages: RetroMessage[];
  unavailable: string | null;
}

type Phase = "start" | "mid" | "end";
type Origin = "typed" | "issue" | "auto" | "schedule" | "repair" | "template";

interface SessionDigest {
  desig: string;
  origin: Origin;
  /** Typed sessions only: the others' prompts are composed by Shepherd, not the operator. */
  openingPrompt: string | null;
  outcome: string | null;
  durationMin: number | null;
  shepherdSteers: Record<string, number>;
  operatorSteerCount: number;
  operatorSteers: { phase: Phase; text: string }[];
  /** False when the 100-message window may have cut early steers. */
  windowComplete: boolean;
  /** Why no transcript was read; null when it was. */
  transcript: string | null;
}

interface Digest {
  sample: {
    repo: string | null;
    limit: number;
    considered: number;
    skipped: {
      unarchived: number;
      terminal: number;
      relaunch: number;
      noop: number;
      otherRepo: number;
    };
  };
  sessions: SessionDigest[];
}

/** The messages window the CLI serves at most; a full window may have cut older messages. */
const MESSAGE_WINDOW = 100;
const PROMPT_CAP = 1200;
const STEER_CAP = 400;
const STEERS_KEPT_EACH_END = 4;
/** An opening this long, shared by at least TEMPLATE_MIN archived sessions, is a canned prompt
 *  (merge-train launch, epic draft, integration alert), not one the operator wrote. */
const TEMPLATE_PREFIX = 40;
const TEMPLATE_MIN = 3;

/** Automatic steers the steer-log classifier does not tag: the `Shepherd:`-prefixed ones (CI
 *  finished, merged, review feedback, rate limit) and the base-drift notice (src/base-drift.ts).
 *  A failed CI run is the rework signal and a merge the outcome, so both get their own kind. */
const SHEPHERD_PREFIX = "Shepherd:";
const CI_RED = /^Shepherd: CI [^\n]*?\bfailed\b/;
const MERGED = /^Shepherd: PR #\S+ merged\b/;
const BASE_MOVED = "Heads-up: your base branch moved";
/** Steers that arrive after the work is done; the agent's replies to them are not session activity. */
const TAIL_KINDS = new Set(["merged", "base_moved"]);

/** Strips Claude Code's paste wrapper. A copy of src/steer-log.ts `unwrapPasted`: a sandbox
 *  membrane binds only the agent-skills directory, so this script cannot import from src/. */
const PASTED_RE = /<pasted_content id="([^"]*)">\n?([\s\S]*?)\n?<\/pasted_content(?: id="\1")?>/g;
const unwrapPasted = (text: string) =>
  text.replace(PASTED_RE, (_, _id: string, body: string) => body).trim();

/** User-role transcript records nobody typed: Claude Code's background-task notices, slash-command
 *  echoes, the compaction summary and interrupt markers. Neither a steer nor a prompt. */
const HARNESS =
  /^(?:<task-notification>|<command-(?:name|message)>|<local-command-|This session is being continued from a previous conversation|\[Request interrupted by user)/;

function untaggedShepherdKind(text: string): string | null {
  if (CI_RED.test(text)) return "ci_red";
  if (MERGED.test(text)) return "merged";
  if (text.startsWith(BASE_MOVED)) return "base_moved";
  return text.startsWith(SHEPHERD_PREFIX) ? "shepherd_other" : null;
}

const cap = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

const openingOf = (prompt: string) => prompt.trim().slice(0, TEMPLATE_PREFIX);

function templateOpenings(sessions: RetroSession[]): Set<string> {
  const counts = new Map<string, number>();
  for (const s of sessions) {
    // A relaunch repeats its predecessor's prompt; counting it would make a retried prompt canned.
    if (s.archivedAt == null || s.archiveReason === "relaunch") continue;
    const key = openingOf(s.prompt);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n >= TEMPLATE_MIN).map(([key]) => key));
}

function originOf(s: RetroSession, templates: Set<string>): Origin {
  if (s.auto) return "auto";
  if (s.scheduleId) return "schedule";
  if (s.issueNumber != null) return "issue";
  if (s.landingRepair) return "repair";
  return templates.has(openingOf(s.prompt)) ? "template" : "typed";
}

function phaseOf(ts: number, start: number, end: number | null): Phase {
  if (!ts || end == null || end <= start) return "mid";
  const pos = (ts - start) / (end - start);
  return pos < 1 / 3 ? "start" : pos < 2 / 3 ? "mid" : "end";
}

/** One user record: harness noise (null), a Shepherd steer kind, or the operator's own text. */
function classifyUser(m: RetroMessage): { kind: string } | { text: string } | null {
  const text = unwrapPasted(m.text);
  if (HARNESS.test(text)) return null;
  const kind = m.steer ?? untaggedShepherdKind(text);
  return kind ? { kind } : { text };
}

function scanTranscript(messages: RetroMessage[]) {
  const shepherdSteers: Record<string, number> = {};
  const operator: { ts: number; text: string }[] = [];
  let lastActivity = 0;
  let inTail = false;
  for (const m of messages) {
    if (m.role !== "user") {
      if (!inTail) lastActivity = Math.max(lastActivity, m.ts);
      continue;
    }
    const c = m.initial ? null : classifyUser(m);
    if (c && "kind" in c) {
      shepherdSteers[c.kind] = (shepherdSteers[c.kind] ?? 0) + 1;
      inTail ||= TAIL_KINDS.has(c.kind);
    } else if (c) {
      operator.push({ ts: m.ts, text: cap(c.text, STEER_CAP) });
      lastActivity = Math.max(lastActivity, m.ts);
      inTail = false;
    }
  }
  return { shepherdSteers, operator, lastActivity };
}

function digestSession(
  s: RetroSession,
  read: RetroMessages | undefined,
  templates: Set<string>,
): SessionDigest {
  const settled = s.settledAt ?? s.archivedAt;
  const messages = read?.messages ?? [];
  const { shepherdSteers, operator, lastActivity } = scanTranscript(messages);
  // Phases span the session's working life, not the idle tail before the archive.
  const end = lastActivity > s.createdAt ? lastActivity : settled;
  const steers = operator.map(({ ts, text }) => ({ phase: phaseOf(ts, s.createdAt, end), text }));
  const kept =
    steers.length > 2 * STEERS_KEPT_EACH_END
      ? [...steers.slice(0, STEERS_KEPT_EACH_END), ...steers.slice(-STEERS_KEPT_EACH_END)]
      : steers;
  const origin = originOf(s, templates);
  return {
    desig: s.desig,
    origin,
    openingPrompt: origin === "typed" ? cap(s.prompt, PROMPT_CAP) : null,
    outcome: s.archiveReason,
    durationMin: settled == null ? null : Math.round((settled - s.createdAt) / 60_000),
    shepherdSteers,
    operatorSteerCount: operator.length,
    operatorSteers: kept,
    windowComplete: messages.some((m) => m.initial) || messages.length < MESSAGE_WINDOW,
    transcript: read ? read.unavailable : "not-fetched",
  };
}

/** Archived sessions of `repo` (every repo when null) the retro reads, newest first. */
function selectSessions(
  sessions: RetroSession[],
  opts: { repo: string | null; limit: number },
): { kept: RetroSession[]; skipped: Digest["sample"]["skipped"] } {
  const skipped = { unarchived: 0, terminal: 0, relaunch: 0, noop: 0, otherRepo: 0 };
  const kept = sessions.filter((s) => {
    if (s.archivedAt == null) skipped.unarchived++;
    else if (s.terminal) skipped.terminal++;
    else if (s.archiveReason === "relaunch") skipped.relaunch++;
    else if (s.archiveReason === "noop") skipped.noop++;
    else if (opts.repo != null && s.repoPath !== opts.repo) skipped.otherRepo++;
    else return true;
    return false;
  });
  kept.sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
  return { kept: kept.slice(0, opts.limit), skipped };
}

/** Reduce sessions + their transcripts (keyed by session id) to the retro digest. */
export function summarize(
  sessions: RetroSession[],
  messagesById: Map<string, RetroMessages>,
  opts: { repo: string | null; limit: number },
): Digest {
  const { kept, skipped } = selectSessions(sessions, opts);
  const templates = templateOpenings(sessions);
  return {
    sample: { repo: opts.repo, limit: opts.limit, considered: kept.length, skipped },
    sessions: kept.map((s) => digestSession(s, messagesById.get(s.id), templates)),
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────

const FATAL_EXIT: Record<number, string> = {
  3: "the shepherd CLI is not authenticated",
  4: "the shepherd CLI token lacks the `full` scope (needed for `sessions list --all` and `messages`)",
  7: "the Shepherd server is unreachable from this session",
};

class CliError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

async function run(
  cmd: string[],
  env: Record<string, string | undefined> = process.env,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

async function shepherd(profile: string | null, args: string[]): Promise<unknown> {
  const base = ["shepherd", "--json", ...(profile ? ["--profile", profile] : [])];
  // The CLI prefers $SHEPHERD_TOKEN over the profile's token; a profile named on purpose wins here.
  const env = { ...process.env };
  if (profile) delete env.SHEPHERD_TOKEN;
  const r = await run([...base, ...args], env);
  if (r.code !== 0) throw new CliError(r.code, r.stderr.trim() || `exit ${r.code}`);
  return JSON.parse(r.stdout);
}

async function mainCheckout(): Promise<string> {
  const r = await run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (r.code !== 0) throw new Error(`not in a git repository: ${r.stderr.trim()}`);
  return dirname(r.stdout.trim());
}

async function readMessages(profile: string | null, id: string): Promise<RetroMessages> {
  try {
    const out = (await shepherd(profile, [
      "messages",
      id,
      "-n",
      String(MESSAGE_WINDOW),
      "--include-user",
    ])) as RetroMessages;
    return { messages: out.messages ?? [], unavailable: out.unavailable ?? null };
  } catch (e) {
    if (e instanceof CliError && FATAL_EXIT[e.code]) throw e;
    return { messages: [], unavailable: `cli-error: ${(e as Error).message.slice(0, 200)}` };
  }
}

async function mapLimit<T, R>(items: T[], width: number, fn: (item: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  return out;
}

function parseArgs(argv: string[]) {
  const opts = {
    limit: 30,
    repo: null as string | null,
    allRepos: false,
    profile: null as string | null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all-repos") opts.allRepos = true;
    else if (a === "--limit") opts.limit = Number.parseInt(argv[++i] ?? "", 10);
    else if (a === "--repo") opts.repo = argv[++i] ?? null;
    else if (a === "--profile") opts.profile = argv[++i] ?? null;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(opts.limit) || opts.limit < 1)
    throw new Error("--limit takes a positive integer");
  return opts;
}

async function main(argv: string[]): Promise<number> {
  let opts: ReturnType<typeof parseArgs>;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`prompt-retro: ${(e as Error).message}\n`);
    return 2;
  }
  const repo = opts.allRepos ? null : (opts.repo ?? (await mainCheckout()));
  try {
    const all = (await shepherd(opts.profile, ["sessions", "list", "--all"])) as RetroSession[];
    const { kept } = selectSessions(all, { repo, limit: opts.limit });
    const reads = await mapLimit(kept, 4, (s) => readMessages(opts.profile, s.id));
    const byId = new Map(kept.map((s, i) => [s.id, reads[i] as RetroMessages]));
    process.stdout.write(
      `${JSON.stringify(summarize(all, byId, { repo, limit: opts.limit }), null, 1)}\n`,
    );
    return 0;
  } catch (e) {
    if (!(e instanceof CliError)) throw e;
    const why = FATAL_EXIT[e.code];
    process.stderr.write(`prompt-retro: ${why ?? "shepherd CLI failed"} — ${e.message}\n`);
    return e.code;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
