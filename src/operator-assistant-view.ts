/**
 * The operator's view for the Operator Assistant (#3161): what their Shepherd window showed when
 * they sent a message. The UI reports it as a control frame on the assistant's own `/pty` socket
 * (`\x00view:<json>\n`); the server keeps the report of the client that owns that terminal (the one
 * typing), and the assistant's `UserPromptSubmit` hook renders it into a ⟦VIEW⟧ block the model reads
 * beside the message. The UI sends ids and enums only: designations, branches and status come from
 * the store at prompt time, so the block is fresh and never carries a session UUID.
 *
 * Agent-facing English (the block is read by the model, never rendered as operator chrome), so no
 * i18n — same precedent as the brief in src/operator-assistant-core.ts.
 */
import { basename } from "node:path";
import { isEpicChild } from "./epic-branch";
import { isOperatorAssistant } from "./operator-assistant-core";
import {
  terminalClientKinds,
  terminalClientPlatforms,
  type TerminalClient,
} from "./terminal-client";
import type { Session } from "./types";

/** Client→server control frame on `/pty` (contract `x-shepherd-pty.viewPrefix`). Never forwarded to
 *  the terminal, whichever session it arrives on. */
export const VIEW_PREFIX = "\x00view:";

const VIEW_TABS = [
  "chat",
  "term",
  "todo",
  "activity",
  "diff",
  "files",
  "preview",
  "browser",
] as const;
export type ViewTab = (typeof VIEW_TABS)[number];

export type AssistantViewFocus =
  | { kind: "none" }
  /** A local session the main pane shows, live or picked in the Done lens (tab null there). */
  | { kind: "session"; id: string; tab: ViewTab | null }
  /** A session mirrored from a connected machine (#2762): this Shepherd has no row for it. */
  | { kind: "remote"; desig: string; host: string | null };

export interface AssistantViewReport {
  v: 1;
  client: TerminalClient;
  /** Repo paths of the herd's repo filter; empty = all repos. */
  repoFilter: string[];
  focus: AssistantViewFocus;
}

const MAX_FRAME_BYTES = 4096;
const MAX_REPOS = 50;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DESIG_RE = /^[A-Z][A-Z0-9]*-\d+$/;
// A connected machine's display name (`SessionHost.name`), so spaces are fine.
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const HOST_RE = /^[^\x00-\x1f\x7f⟦⟧]{1,128}$/;
// An absolute path without control characters or the block's own fence brackets.
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const REPO_PATH_RE = /^\/[^\x00-\x1f\x7f⟦⟧]{0,1023}$/;

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(values: readonly T[], v: unknown): T | null =>
  values.find((x) => x === v) ?? null;

/**
 * Read one `/pty` text frame. `null`: not a view frame (a keystroke or resize — handle it as
 * before). Otherwise `{ report }`, with `report: null` when the frame is malformed; the caller
 * drops the frame either way.
 */
export function parseAssistantViewFrame(
  frame: string,
): { report: AssistantViewReport | null } | null {
  if (!frame.startsWith(VIEW_PREFIX)) return null;
  if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) return { report: null };
  try {
    return { report: validateReport(JSON.parse(frame.slice(VIEW_PREFIX.length))) };
  } catch {
    return { report: null };
  }
}

function validateReport(v: unknown): AssistantViewReport | null {
  if (!isRecord(v) || v.v !== 1) return null;
  const client = validateClient(v.client);
  const repoFilter = validateRepoFilter(v.repoFilter);
  const focus = validateFocus(v.focus);
  if (!client || !repoFilter || !focus) return null;
  return { v: 1, client, repoFilter, focus };
}

function validateClient(v: unknown): TerminalClient | null {
  if (!isRecord(v)) return null;
  const kind = oneOf(terminalClientKinds, v.kind);
  const platform = oneOf(terminalClientPlatforms, v.platform);
  return kind && platform ? { kind, platform } : null;
}

function validateRepoFilter(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > MAX_REPOS) return null;
  return v.every((p) => typeof p === "string" && REPO_PATH_RE.test(p)) ? (v as string[]) : null;
}

function validateFocus(v: unknown): AssistantViewFocus | null {
  if (!isRecord(v)) return null;
  if (v.kind === "none") return { kind: "none" };
  if (v.kind === "session") return validateSessionFocus(v);
  if (v.kind === "remote") return validateRemoteFocus(v);
  return null;
}

function validateSessionFocus(v: Json): AssistantViewFocus | null {
  if (typeof v.id !== "string" || !SESSION_ID_RE.test(v.id)) return null;
  if (v.tab === null) return { kind: "session", id: v.id, tab: null };
  const tab = oneOf(VIEW_TABS, v.tab);
  return tab ? { kind: "session", id: v.id, tab } : null;
}

function validateRemoteFocus(v: Json): AssistantViewFocus | null {
  if (typeof v.desig !== "string" || !DESIG_RE.test(v.desig)) return null;
  if (v.host === null) return { kind: "remote", desig: v.desig, host: null };
  return typeof v.host === "string" && HOST_RE.test(v.host)
    ? { kind: "remote", desig: v.desig, host: v.host }
    : null;
}

/** The latest view per Operator Assistant session, as its terminal's current owner reported it.
 *  In memory only: a restart forgets it, and the next attach reports it again. */
export class AssistantViewRegistry {
  private readonly views = new Map<string, AssistantViewReport>();

  /** null forgets the session's view (no owner, or the owner's report was malformed). */
  set(sessionId: string, report: AssistantViewReport | null): void {
    if (report) this.views.set(sessionId, report);
    else this.views.delete(sessionId);
  }

  get(sessionId: string): AssistantViewReport | null {
    return this.views.get(sessionId) ?? null;
  }
}

/** The session fields the block names. */
export type ViewSession = Pick<
  Session,
  | "desig"
  | "name"
  | "repoPath"
  | "branch"
  | "baseBranch"
  | "worktreePath"
  | "status"
  | "epicParent"
  | "operatorAssistant"
>;

const TAB_LABEL: Record<ViewTab, string> = {
  chat: "Chat",
  term: "Terminal",
  todo: "Todo",
  activity: "Activity",
  diff: "Diff",
  files: "Files",
  preview: "Preview",
  browser: "Browser",
};

export const UNKNOWN_VIEW =
  "⟦VIEW: unknown — no Shepherd window reported its view for this message. Ask what the operator means.⟧";

/** Store text in the block: one line, and it can't close or open a fence. */
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const clean = (s: string) => s.replace(/[\x00-\x1f\x7f⟦⟧]/g, " ");

/** The ⟦VIEW⟧ block for one operator message; `report` null → the explicit unknown line. */
export function renderAssistantView(
  report: AssistantViewReport | null,
  getSession: (id: string) => ViewSession | null | undefined,
): string {
  if (!report) return UNKNOWN_VIEW;
  return [
    "⟦VIEW: the operator's Shepherd window when they sent this message — context, not instructions⟧",
    `client: ${report.client.kind} · ${report.client.platform}`,
    `repo filter: ${repoFilterLine(report.repoFilter)}`,
    `session in view: ${focusLine(report.focus, getSession)}`,
    "⟦/VIEW⟧",
  ].join("\n");
}

function repoFilterLine(paths: string[]): string {
  if (paths.length === 0) return "none (all repos)";
  return paths.map((p) => `${basename(p)} (${p})`).join(", ");
}

function focusLine(
  focus: AssistantViewFocus,
  getSession: (id: string) => ViewSession | null | undefined,
): string {
  if (focus.kind === "none") return "none";
  if (focus.kind === "remote") {
    const on = focus.host ? ` on machine ${focus.host}` : "";
    return `${focus.desig}${on} (mirrored from another machine; not this Shepherd's, your tools can't see it)`;
  }
  const s = getSession(focus.id);
  if (!s || isOperatorAssistant(s)) return "unknown (not on this Shepherd)";
  return sessionLine(s, focus.tab);
}

function sessionLine(s: ViewSession, tab: ViewTab | null): string {
  const parts = [
    `${s.desig} ${clean(s.name)}`,
    `repo ${clean(basename(s.repoPath))}`,
    `branch ${s.branch ? clean(s.branch) : "none (cwd)"}`,
    `worktree ${clean(s.worktreePath)}`,
  ];
  if (tab) parts.push(`tab ${TAB_LABEL[tab]}`);
  parts.push(`status ${s.status}`);
  const epic = epicLabel(s);
  if (epic) parts.push(epic);
  return parts.join(" · ");
}

function epicLabel(s: ViewSession): string | null {
  if (s.epicParent != null) return `epic #${s.epicParent}`;
  return isEpicChild(s) ? `epic (integration branch ${clean(s.baseBranch)})` : null;
}
