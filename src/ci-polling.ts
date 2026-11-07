/**
 * Detect an agent that polls CI itself (#2863): after a push it loops `sleep` + `gh run view` /
 * `gh pr checks` instead of ending its turn, burning a full-context request per poll. Shepherd
 * already steers on red and starts the critic on green, so the polling buys nothing.
 *
 * Read off the transcript tail the activity probe already parses: the trailing run of shell calls
 * that only wait on CI. Any other tool call — or a shell command doing real work, such as a
 * `git push` (a new head) — ends the run. Claude transcripts and Codex rollouts differ in shape,
 * so each has its own walker over the same rule (Codex's lives in src/codex-activity.ts, beside
 * its rollout parser).
 */
/** This many CI polls in a row reads as polling (one check after a push is fine). */
export const CI_POLL_MIN = 3;

export interface CiPolling {
  /** CI polls in the trailing run (sleeps don't count). */
  polls: number;
  /** Input-side tokens the polling requests consumed (cache reads included: each poll resends the
   *  whole context). A lower bound when the run started before the read tail. */
  inputTokens: number;
  /** ms epoch of the run's first call. */
  since: number;
}

const POLL_RE =
  /^gh\s+(?:run\s+(?:view|watch|list)|pr\s+checks|api\s+\S*(?:\/check-runs|\/check-suites|\/actions\/runs|\/status)\b)/;
const SLEEP_RE = /^sleep\s+\d+(?:\.\d+)?[smh]?$/;

function segments(cmd: string): string[] {
  return cmd
    .split(/&&|\|\||;|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A `gh` command that reads CI state. Pipes into a formatter (`| jq …`, `| tail`) are allowed;
 *  reading a run's logs (`--log`, `--log-failed`) is real work on a failure, not polling. */
function isPollSegment(seg: string): boolean {
  const head = seg.split("|")[0]!.trim();
  return POLL_RE.test(head) && !/\s--log\b/.test(head);
}

/** A shell command that does nothing but wait on CI: sleeps and CI reads only. */
export function isCiWaitCommand(cmd: string): boolean {
  const segs = segments(cmd);
  return segs.length > 0 && segs.every((s) => SLEEP_RE.test(s) || isPollSegment(s));
}

/** How many CI reads one command makes (0 for a bare sleep or anything else). */
function ciPollCount(cmd: string): number {
  return segments(cmd).filter(isPollSegment).length;
}

/** One tool call as the walker sees it: its shell command (null for any non-shell tool), when,
 *  and the request (+ its input tokens) that made it. */
export interface CiCall {
  cmd: string | null;
  ts: number;
  request: string;
}

/** The trailing run of CI-wait calls, or null below CI_POLL_MIN polls. `tokensOf` prices the
 *  requests in the run. */
export function trailingCiPolling(
  calls: CiCall[],
  tokensOf: (requests: CiCall[]) => number,
): CiPolling | null {
  let start = calls.length;
  while (start > 0) {
    const cmd = calls[start - 1]!.cmd;
    if (cmd === null || !isCiWaitCommand(cmd)) break;
    start--;
  }
  const run = calls.slice(start);
  const polls = run.reduce((n, c) => n + ciPollCount(c.cmd!), 0);
  if (polls < CI_POLL_MIN) return null;
  return { polls, inputTokens: tokensOf(run), since: run[0]!.ts };
}

export const tokenNum = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
export const recordTs = (o: { timestamp?: unknown }) => Date.parse(o.timestamp as string) || 0;

interface ClaudeRecord {
  type?: unknown;
  timestamp?: unknown;
  message?: {
    id?: unknown;
    content?: unknown;
    usage?: {
      input_tokens?: unknown;
      cache_read_input_tokens?: unknown;
      cache_creation_input_tokens?: unknown;
    };
  };
}

/** Claude Code JSONL: assistant records carry `tool_use` blocks; one API message can span several
 *  records that repeat its `message.id` and usage, so tokens are counted once per id. */
export function claudeCiPolling(objs: Iterable<unknown>): CiPolling | null {
  const calls: CiCall[] = [];
  const usage = new Map<string, number>();
  for (const o of objs) {
    const rec = o as ClaudeRecord;
    if (rec.type !== "assistant" || !Array.isArray(rec.message?.content)) continue;
    const msg = rec.message!;
    const request = typeof msg.id === "string" ? msg.id : `${calls.length}`;
    const u = msg.usage;
    if (u)
      usage.set(
        request,
        tokenNum(u.input_tokens) +
          tokenNum(u.cache_read_input_tokens) +
          tokenNum(u.cache_creation_input_tokens),
      );
    for (const b of msg.content as { type?: unknown; name?: unknown; input?: unknown }[]) {
      if (b?.type !== "tool_use") continue;
      const command = (b.input as { command?: unknown } | undefined)?.command;
      const cmd = b.name === "Bash" && typeof command === "string" ? command : null;
      calls.push({ cmd, ts: recordTs(rec), request });
    }
  }
  return trailingCiPolling(calls, (run) =>
    [...new Set(run.map((c) => c.request))].reduce((sum, id) => sum + (usage.get(id) ?? 0), 0),
  );
}
