/** In-session attachments are delivered by bracket-pasting their worktree path into the
 *  agent's PTY. A video needs a nudge the path alone doesn't give: agents can't watch it,
 *  so without the hint a screen recording just sits in the worktree unused. Phrasing kept
 *  aligned with the launch-prompt note in src/service.ts (composeUploadPrompt). */
export function attachmentPastePayload(path: string, mime: string): string {
  if (!mime.toLowerCase().startsWith("video/")) return path;
  return `${path} (screen-recording video — extract keyframes/audio with ffmpeg to view)`;
}
