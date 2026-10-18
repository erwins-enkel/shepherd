import type { Session, TerminalClientInfo } from "./types";

/** The tabs of a session's Viewport (its `tab` state). */
export type ViewTab = "term" | "todo" | "activity" | "diff" | "files" | "preview" | "browser";

/**
 * What the Operator Assistant learns about the operator's window with each message (#3161): sent
 * on the assistant's own terminal socket (PtyConn.view), validated and rendered into a ⟦VIEW⟧
 * block by the server (src/operator-assistant-view.ts, which this mirrors). Ids and enums only —
 * the server names the session from its own store, so no title or prompt leaves the client here.
 */
export interface AssistantViewReport {
  v: 1;
  client: TerminalClientInfo;
  /** Repo paths of the herd's repo filter; empty = all repos. */
  repoFilter: string[];
  focus:
    | { kind: "none" }
    | { kind: "session"; id: string; tab: ViewTab | null }
    | { kind: "remote"; desig: string; host: string | null };
}

/**
 * The report for the page's current state. The session in view is what the main pane shows: the
 * picked row in the Done lens (its recap, no tab), else the selected session with its Viewport
 * tab, else a selected mirrored session. On a phone the assistant is its own screen, so the
 * session counts only when the operator opened the assistant from that session's detail.
 */
export function buildAssistantViewReport(i: {
  client: TerminalClientInfo;
  repoFilter: Iterable<string>;
  mobile: boolean;
  /** The phone screen the assistant was opened from (Back returns there). */
  assistantReturnScreen: "list" | "detail";
  doneLens: boolean;
  selected: Pick<Session, "id"> | null;
  doneSelected: Pick<Session, "id"> | null;
  selectedRemote: Pick<Session, "desig" | "host"> | null;
  sessionTab: ViewTab;
}): AssistantViewReport {
  return {
    v: 1,
    client: i.client,
    repoFilter: [...i.repoFilter],
    focus: i.mobile && i.assistantReturnScreen !== "detail" ? { kind: "none" } : mainPaneFocus(i),
  };
}

function mainPaneFocus(i: Parameters<typeof buildAssistantViewReport>[0]) {
  if (i.doneLens) {
    return i.doneSelected
      ? { kind: "session" as const, id: i.doneSelected.id, tab: null }
      : { kind: "none" as const };
  }
  if (i.selected) return { kind: "session" as const, id: i.selected.id, tab: i.sessionTab };
  if (i.selectedRemote) {
    const host = i.selectedRemote.host?.name ?? null;
    return { kind: "remote" as const, desig: i.selectedRemote.desig, host };
  }
  return { kind: "none" as const };
}
