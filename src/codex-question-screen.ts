// Codex 0.165.0's two question surfaces. Only inspect live visible terminal text.
export interface CodexQuestionScreen {
  mode: "sync" | "async";
  count: number;
  index: number;
  body: string;
  selected: number | null;
  notes: boolean;
  unanswered?: number;
}

export function codexQuestionHint(text: string): { count: number; key: string } | null {
  const m =
    /^\s*\?\s+([1-9]\d*)\s+questions?(?:\s*·\s*[^\r\n]+)?\s*\r?\n\s*(alt\s*\+\s*↑|shift\s*\+\s*←)\s+to\s+answer[^\S\r\n]*$/im.exec(
      text,
    );
  return m ? { count: Number(m[1]), key: /^alt/i.test(m[2]!) ? "\x1b[1;3A" : "\x1b[1;2D" } : null;
}

export function readCodexQuestionScreen(text: string): CodexQuestionScreen | null {
  const sync =
    /(?:^|\n)\s*Question (\d+)\/(\d+) \((\d+) unanswered\)\s*\n([\s\S]*?)\n\s*tab (to add notes|or esc to clear notes) \| enter to submit (?:answer|all)[^\n]*\s*$/.exec(
      text.trimEnd(),
    );
  if (sync)
    return {
      ...screen("sync", Number(sync[2]), Number(sync[1]) - 1, sync[4]!),
      unanswered: Number(sync[3]),
      notes: sync[5] === "or esc to clear notes",
    };
  const start = text.lastIndexOf("Queued follow-up inputs");
  if (start < 0) return null;
  const async =
    /^\s*(?:(\d+) of (\d+)\s*\n)?([\s\S]*?)\n\s*enter submit\s+\^\] skip[^\n]*\s*$/.exec(
      text.slice(start + "Queued follow-up inputs".length).trim(),
    );
  if (!async) return null;
  return screen("async", Number(async[2] ?? 1), Number(async[1] ?? 1) - 1, async[3]!);
}

function screen(
  mode: "sync" | "async",
  count: number,
  index: number,
  body: string,
): CodexQuestionScreen {
  const selected = /^\s*[›❯>]\s+(\d+)\. /m.exec(body);
  return {
    mode,
    count,
    index,
    body,
    selected: selected ? Number(selected[1]) - 1 : null,
    notes: false,
  };
}

/** Match the entire prompt before its option rows, not a transcript quote above the dialog. */
export function codexScreenMatches(screen: CodexQuestionScreen, question: string): boolean {
  const parts = screen.body.split(/\n\s*(?:[›❯>]\s*)?1\. /);
  const prompt =
    parts.length > 1
      ? parts[0]!
      : screen.body
          .trim()
          .split(/\n[ \t]*\n/)
          .slice(0, -1)
          .join("\n\n");
  return prompt.replace(/\s+/g, " ").trim() === question.replace(/\s+/g, " ").trim();
}
