/**
 * Opener composition (issue #3778): what a Claude spawn's FIRST request carries, block by block.
 *
 * Claude Code records each API request in the transcript: `api-request-shape` (system blocks + tool
 * schemas), `api-request-blob` (message bodies, by hash) and `api-request` (which shape + blobs one
 * request used). The first main-thread request is the opener — everything resident before the
 * session does any work, re-read on every later turn. This module attributes its characters to named
 * blocks; `fitCalibration` turns characters into tokens against the API's own count (the first
 * assistant record's `input + cache_read + cache_creation`). src/prompt-budget.ts sees only
 * Shepherd's appended payload; this sees the whole request.
 *
 * Pure: no FS or DB. `scripts/opener-composition.ts` feeds it transcripts and DB rows.
 */

/** Characters per named block of one opener. Tool-schema blocks are named `tool:…`/`tools:…` and
 *  priced at their own chars/token (JSON tokenizes differently from prose). */
export type BlockChars = Map<string, number>;

/** What one transcript's opener measured. */
export interface OpenerSample {
  blocks: BlockChars;
  /** API-reported first-request context: input + cache_read + cache_creation. */
  tokens: number;
  /** Main-thread requests in the transcript (unique request ids) — how often the opener is paid. */
  requests: number;
}

interface Shape {
  system?: { text?: string }[];
  tools?: { name?: string }[];
}

interface Message {
  role?: string;
  content?: string | { type?: string; text?: string }[];
}

interface Usage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** The transcript record fields this module reads (all optional: records vary by type). */
interface RawRecord {
  type?: string;
  shapeHash?: string;
  shape?: Shape;
  hash?: string;
  message?: Message & { id?: string; usage?: Usage };
  querySource?: string;
  tail?: string[];
  isSidechain?: boolean;
  requestId?: string;
}

interface FirstRequest {
  shape: Shape;
  messages: Message[];
  tokens: number;
  requests: number;
}

/** Skill names that are not distinguishable from the transcript text alone. */
export interface SkillSets {
  personal: Set<string>;
  shepherd: Set<string>;
}

/** Built-ins reported one by one: the trim targets (#3778) and AskUserQuestion. */
const NAMED_TOOLS = new Set([
  "Artifact",
  "Workflow",
  "SendFeedback",
  "ScheduleWakeup",
  "ReportFindings",
  "ListAgents",
  "AskUserQuestion",
]);

/** Where Shepherd's `--append-system-prompt` payload starts: task spawns lead with the posture
 *  block (composeSystemPromptBlocks), the Operator Assistant with its brief. */
const SHEPHERD_ANCHORS = ["<engineering-posture>\n", "<operator-assistant>\n"];

/** Section headers Claude Code uses inside the per-session system message. */
const SYSMSG_SECTIONS: [string, string][] = [
  ["hook", "SessionStart hook additional context:"],
  ["env", "# Environment\nYou have been invoked"],
  ["deferred", "The following deferred tools are now available via ToolSearch."],
  ["agents", "Available agent types for the Agent tool:"],
  ["mcp", "# MCP Server Instructions"],
  ["skills", "The following skills are available for use with the Skill tool:"],
  ["bypass", "While bypass permissions mode is active:"],
];

// ── transcript → first request ───────────────────────────────────────────────────────────────────

interface Walk {
  shapes: Map<string, Shape>;
  blobs: Map<string, Message>;
  request: { shapeHash: string; tail: string[] } | null;
  usage: Usage | null;
  requestIds: Set<string>;
}

function isMainRequest(source: string | undefined): boolean {
  return source === "repl_main_thread" || source === "sdk";
}

function onApiRecord(w: Walk, o: RawRecord): void {
  if (o.type === "api-request-shape" && o.shapeHash && o.shape) w.shapes.set(o.shapeHash, o.shape);
  else if (o.type === "api-request-blob" && o.hash && o.message) w.blobs.set(o.hash, o.message);
  else if (o.type === "api-request" && !w.request && o.shapeHash && isMainRequest(o.querySource)) {
    w.request = { shapeHash: o.shapeHash, tail: o.tail ?? [] };
  }
}

function onAssistant(w: Walk, o: RawRecord): void {
  if (o.isSidechain) return;
  const id = o.requestId ?? o.message?.id;
  if (id) w.requestIds.add(id);
  if (!w.usage && o.message?.usage) w.usage = o.message.usage;
}

/** The first main-thread request of a transcript, or null when it predates request recording
 *  (Claude Code < 2.1.3xx) or never completed one. */
export function firstRequest(lines: Iterable<string>): FirstRequest | null {
  const w: Walk = {
    shapes: new Map(),
    blobs: new Map(),
    request: null,
    usage: null,
    requestIds: new Set(),
  };
  for (const line of lines) {
    const api = line.startsWith('{"type":"api-request');
    if (!api && !line.includes('"type":"assistant"')) continue;
    let o: RawRecord;
    try {
      o = JSON.parse(line) as RawRecord;
    } catch {
      continue;
    }
    if (api) onApiRecord(w, o);
    else if (o.type === "assistant") onAssistant(w, o);
  }
  const shape = w.request && w.shapes.get(w.request.shapeHash);
  if (!w.request || !shape || !w.usage) return null;
  const u = w.usage;
  return {
    shape,
    messages: w.request.tail.flatMap((h) => w.blobs.get(h) ?? []),
    tokens:
      (u.input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0),
    requests: w.requestIds.size,
  };
}

// ── first request → blocks ──────────────────────────────────────────────────────────────────────

function add(blocks: BlockChars, name: string, chars: number): void {
  if (chars > 0) blocks.set(name, (blocks.get(name) ?? 0) + chars);
}

/** Cut `section` (from `header` to the next top-level `# ` heading) out of `text`. */
function cutSection(text: string, header: string): { rest: string; chars: number } {
  const start = text.indexOf(header);
  if (start < 0) return { rest: text, chars: 0 };
  const next = text.indexOf("\n# ", start + header.length);
  const end = next < 0 ? text.length : next;
  return { rest: text.slice(0, start) + text.slice(end), chars: end - start };
}

function attributeShepherd(blocks: BlockChars, text: string): void {
  const tagged = [...text.matchAll(/<([a-z][a-z0-9-]*)>\n[\s\S]*?\n<\/\1>/g)];
  for (const m of tagged) add(blocks, `shepherd:${m[1]}`, m[0].length);
  add(blocks, "shepherd:untagged", text.length - tagged.reduce((s, m) => s + m[0].length, 0));
}

/** System blocks 0–1 are Claude Code's static prompt; the last carries its per-session sections
 *  and, at the tail, Shepherd's appended payload. */
function attributeSystem(blocks: BlockChars, system: { text?: string }[]): void {
  system.forEach((b, i) => {
    const text = b.text ?? "";
    if (i < 2) return add(blocks, "system:cc-base", text.length);
    const at = Math.min(...SHEPHERD_ANCHORS.map((a) => text.indexOf(a)).filter((n) => n >= 0));
    const split = Number.isFinite(at) ? at : text.length;
    let cc = text.slice(0, split);
    for (const [name, header] of [
      ["system:chrome", "# Claude in Chrome browser automation"],
      ["system:memory-howto", "# Memory\n"],
    ] as const) {
      const cut = cutSection(cc, header);
      add(blocks, name, cut.chars);
      cc = cut.rest;
    }
    add(blocks, "system:cc-dynamic", cc.length);
    attributeShepherd(blocks, text.slice(split));
  });
}

function attributeTools(blocks: BlockChars, tools: { name?: string }[]): void {
  for (const t of tools) {
    const name = t.name ?? "?";
    add(blocks, NAMED_TOOLS.has(name) ? `tool:${name}` : "tools:core", JSON.stringify(t).length);
  }
}

function claudeMdBlock(path: string, home: string): string {
  if (path.endsWith("/MEMORY.md")) return "claudemd:memory-index";
  if (path.startsWith(`${home}/.claude/`)) return "claudemd:user";
  return "claudemd:project";
}

function attributeInstructions(blocks: BlockChars, text: string, home: string): void {
  const parts = text.split(/^(?=Contents of )/m);
  add(blocks, "claudemd:header", parts[0]!.length);
  for (const p of parts.slice(1)) {
    add(blocks, claudeMdBlock(/^Contents of (\S+)/.exec(p)?.[1] ?? "", home), p.length);
  }
}

function userTextBlock(text: string): string {
  if (text.startsWith("<system-reminder>\nAs you answer")) return "user:context";
  if (text.slice(0, 200).includes("Attribution for git commits")) return "user:attribution";
  if (text.startsWith("<system-reminder>")) return "user:reminder-other";
  return "task-prompt";
}

function texts(m: Message): string[] {
  if (typeof m.content === "string") return [m.content];
  return (m.content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : JSON.stringify(c)));
}

function attributeUser(blocks: BlockChars, m: Message, home: string): void {
  for (const t of texts(m)) {
    if (t.startsWith("<system-reminder>\nCodebase and user instructions")) {
      attributeInstructions(blocks, t, home);
    } else add(blocks, userTextBlock(t), t.length);
  }
}

function skillBlock(name: string, sets: SkillSets): string {
  if (name.startsWith("anthropic-skills:")) return "skills:claude-ai";
  if (name.includes(":")) return `skills:plugin:${name.split(":")[0]}`;
  if (sets.personal.has(name)) return "skills:personal";
  if (sets.shepherd.has(name)) return "skills:shepherd";
  return "skills:bundled+repo";
}

/** Attribute one listing section line by line; `blockOf` names the block of an item line (or
 *  null for a header/continuation line, which stays with the previous item). */
function attributeLines(
  blocks: BlockChars,
  chunk: string,
  header: string,
  blockOf: (line: string) => string | null,
): void {
  let current = header;
  const lines = chunk.split("\n");
  lines.forEach((line, i) => {
    current = blockOf(line) ?? current;
    add(blocks, current, line.length + (i < lines.length - 1 ? 1 : 0)); // + its newline
  });
}

function deferredBlock(line: string): string | null {
  if (!line.startsWith("mcp__")) {
    return line.trim() && !line.startsWith("The following") ? "deferred:builtin" : null;
  }
  return `deferred:${
    line
      .split("__")[1]!
      .replace(/^plugin_/, "")
      .split("_")[0]
  }`;
}

function sectionBlockOf(section: string, sets: SkillSets): (line: string) => string | null {
  switch (section) {
    case "skills":
      return (l) => {
        const m = /^- ([^\s:][^\s]*?)(?::\s|$)/.exec(l);
        return m ? skillBlock(m[1]!, sets) : null;
      };
    case "deferred":
      return deferredBlock;
    case "agents":
      return (l) =>
        /^- [^:\s]+:[^:\s]+:/.test(l) ? "agents:plugin" : /^- /.test(l) ? "agents:builtin" : null;
    case "mcp":
      return (l) =>
        l.startsWith("## ")
          ? `mcp:${
              l
                .slice(3)
                .replace(/^plugin:/, "")
                .split(":")[0]
            }`
          : null;
    default:
      return () => null;
  }
}

function hookBlock(chunk: string): string {
  return chunk.slice(0, 200).includes("You have superpowers") ? "hook:superpowers" : "hook:other";
}

/** The per-session system message: hook injections, environment, deferred tools, agents, MCP
 *  instructions, the skill catalog. Split at Claude Code's fixed section headers. */
function attributeSystemMessage(blocks: BlockChars, text: string, sets: SkillSets): void {
  const cuts = SYSMSG_SECTIONS.map(([name, h]) => ({ name, at: text.indexOf(h) }))
    .filter((c) => c.at >= 0)
    .sort((a, b) => a.at - b.at);
  add(blocks, "sysmsg:other", cuts.length ? cuts[0]!.at : text.length);
  cuts.forEach((c, i) => {
    const chunk = text.slice(c.at, cuts[i + 1]?.at ?? text.length);
    if (c.name === "hook") return add(blocks, hookBlock(chunk), chunk.length);
    const header = `${c.name}:header`;
    if (["skills", "deferred", "agents", "mcp"].includes(c.name)) {
      return attributeLines(blocks, chunk, header, sectionBlockOf(c.name, sets));
    }
    add(blocks, `sysmsg:${c.name}`, chunk.length);
  });
}

/** Characters per named block of a first request. */
export function attributeOpener(fr: FirstRequest, sets: SkillSets, home: string): BlockChars {
  const blocks: BlockChars = new Map();
  attributeTools(blocks, fr.shape.tools ?? []);
  attributeSystem(blocks, fr.shape.system ?? []);
  for (const m of fr.messages) {
    if (m.role === "user") attributeUser(blocks, m, home);
    else for (const t of texts(m)) attributeSystemMessage(blocks, t, sets);
  }
  return blocks;
}

/** One transcript → its opener sample, or null when it carries no recorded request. */
export function openerSample(
  lines: Iterable<string>,
  sets: SkillSets,
  home: string,
): OpenerSample | null {
  const fr = firstRequest(lines);
  if (!fr) return null;
  return { blocks: attributeOpener(fr, sets, home), tokens: fr.tokens, requests: fr.requests };
}

// ── calibration + aggregation ───────────────────────────────────────────────────────────────────

/** Tokens per character, separately for tool schemas (JSON) and everything else (prose). */
export interface Calibration {
  json: number;
  text: number;
}

export function isJsonBlock(name: string): boolean {
  return name.startsWith("tool:") || name.startsWith("tools:");
}

function split(blocks: BlockChars): { json: number; text: number } {
  let json = 0;
  let text = 0;
  for (const [name, chars] of blocks) {
    if (isJsonBlock(name)) json += chars;
    else text += chars;
  }
  return { json, text };
}

/** Least-squares fit (no intercept) of `tokens ≈ a·jsonChars + b·textChars` over the samples. */
export function fitCalibration(samples: OpenerSample[]): Calibration {
  let xx = 0;
  let xy = 0;
  let yy = 0;
  let xt = 0;
  let yt = 0;
  for (const s of samples) {
    const { json: x, text: y } = split(s.blocks);
    xx += x * x;
    xy += x * y;
    yy += y * y;
    xt += x * s.tokens;
    yt += y * s.tokens;
  }
  const det = xx * yy - xy * xy;
  if (det === 0) throw new Error("calibration needs samples with both tool and text content");
  return { json: (xt * yy - yt * xy) / det, text: (yt * xx - xt * xy) / det };
}

/** Estimated tokens of one block under `cal`. */
export function blockTokens(name: string, chars: number, cal: Calibration): number {
  return chars * (isJsonBlock(name) ? cal.json : cal.text);
}

/** (estimate − measured) / measured for one sample — the reconciliation error. */
export function reconcileError(s: OpenerSample, cal: Calibration): number {
  let est = 0;
  for (const [name, chars] of s.blocks) est += blockTokens(name, chars, cal);
  return (est - s.tokens) / s.tokens;
}

/** The `p` quantile (0–1) of `values` by nearest rank; 0 for an empty list. */
export function quantile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

export interface BlockRow {
  name: string;
  /** Median estimated tokens across the kind's samples (0 where a sample lacks the block). */
  median: number;
  /** Σ estimated tokens × requests — what the block costs in re-reads over the window. */
  weighted: number;
}

/** Per-block rows for one group of samples, heaviest (by `weighted`) first. */
export function blockRows(samples: OpenerSample[], cal: Calibration): BlockRow[] {
  const names = new Set(samples.flatMap((s) => [...s.blocks.keys()]));
  return [...names]
    .map((name) => {
      const per = samples.map((s) => blockTokens(name, s.blocks.get(name) ?? 0, cal));
      const weighted = samples.reduce((sum, s, i) => sum + per[i]! * s.requests, 0);
      return { name, median: quantile(per, 0.5), weighted };
    })
    .sort((a, b) => b.weighted - a.weighted);
}
