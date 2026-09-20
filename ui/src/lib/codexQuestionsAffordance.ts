// Only the paired, standalone Codex footer lines advertise this action. A question
// in the conversation or an isolated shortcut mention must not light the button.
export function hasCodexQuestionsHint(screen: string): boolean {
  return /^\s*\?\s+[1-9]\d*\s+questions?\s*\r?\n\s*alt\s*\+\s*↑\s+to\s+answer[^\S\r\n]*$/im.test(
    screen,
  );
}
