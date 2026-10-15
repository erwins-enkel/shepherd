/** Transport threshold, not a limit on the size of a task. Input is already normalized. */
const PROMPT_INLINE_MAX_CHARS = 8000;

export function usesPromptFile(text: string): boolean {
  return text.length > PROMPT_INLINE_MAX_CHARS;
}
