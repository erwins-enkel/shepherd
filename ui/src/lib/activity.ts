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

/** ms-epoch → local HH:MM. */
export function clock(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 5);
}
