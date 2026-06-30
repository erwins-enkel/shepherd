import type { ActivityEntry } from "./types";

/** Classification kind for activity entries. */
export type ActivityKind =
  "edit" | "read" | "search" | "exec" | "tasks" | "agent" | "web" | "other";

/** Grouped activity entries by kind. */
export interface ActivityGroup {
  kind: ActivityKind;
  entries: ActivityEntry[];
}

/** Glyph for an activity entry's tool, grouped by action kind. */
export function glyph(tool: string): string {
  switch (tool) {
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
    case "Write":
      return "✎";
    case "Read":
      return "⤷";
    case "Bash":
      return "$";
    case "Grep":
    case "Glob":
      return "⌕";
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
    case "TaskList":
    case "TaskGet":
      return "⊞";
    case "Task":
    case "Agent":
    case "Skill":
      return "◆";
    case "WebFetch":
    case "WebSearch":
      return "⇲";
    default:
      return "·";
  }
}

/** Classify a tool name into an activity kind. */
export function toolKind(tool: string): ActivityKind {
  switch (tool) {
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
    case "Write":
      return "edit";
    case "Read":
      return "read";
    case "Grep":
    case "Glob":
      return "search";
    case "Bash":
      return "exec";
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
    case "TaskList":
    case "TaskGet":
      return "tasks";
    case "Task":
    case "Agent":
    case "Skill":
      return "agent";
    case "WebFetch":
    case "WebSearch":
      return "web";
    default:
      return "other";
  }
}

/** Coalesce consecutive entries by kind into groups. */
export function groupActivity(entries: ActivityEntry[]): ActivityGroup[] {
  if (entries.length === 0) return [];

  const groups: ActivityGroup[] = [];
  let currentGroup: ActivityGroup | null = null;

  for (const entry of entries) {
    const kind = toolKind(entry.tool);
    if (currentGroup && currentGroup.kind === kind) {
      currentGroup.entries.push(entry);
    } else {
      currentGroup = { kind, entries: [entry] };
      groups.push(currentGroup);
    }
  }

  return groups;
}

/** ms-epoch → local HH:MM. */
export function clock(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 5);
}
