// Only paired live footer lines authorize this native action.
export function codexQuestionsKey(screen: string): string | null {
  const match =
    /^\s*\?\s+[1-9]\d*\s+questions?(?:\s*·\s*[^\r\n]+)?\s*\r?\n\s*(alt\s*\+\s*↑|shift\s*\+\s*←)\s+to\s+answer[^\S\r\n]*$/im.exec(
      screen,
    );
  return match ? (/^alt/i.test(match[1]) ? "\x1b[1;3A" : "\x1b[1;2D") : null;
}

export function hasCodexQuestionsHint(screen: string): boolean {
  return codexQuestionsKey(screen) !== null;
}
