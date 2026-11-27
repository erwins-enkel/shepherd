/** Whether composer text invokes `/design` — the same token rule as the server's
 *  `builtinToolsNeededBy` (src/service.ts), so the Chat offers Artifact exactly where a task
 *  prompt would have kept it (#4293). */
export function invokesDesign(text: string): boolean {
  return /(?:^|\s)\/design(?=\s|$)/.test(text);
}
