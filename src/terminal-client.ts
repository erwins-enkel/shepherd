/** What a `/pty` client says it is (`?clientKind=&clientPlatform=`, contract `TerminalClientInfo`).
 *  Display only, never authorization. Shared by the attach query and the Operator Assistant's view
 *  report (src/operator-assistant-view.ts), which carries the same pair. */
export const terminalClientKinds = ["mac-app", "pwa", "browser", "unknown"] as const;
export const terminalClientPlatforms = [
  "macos",
  "ios",
  "ipados",
  "android",
  "windows",
  "linux",
  "chromeos",
  "unknown",
] as const;

export interface TerminalClient {
  kind: (typeof terminalClientKinds)[number];
  platform: (typeof terminalClientPlatforms)[number];
}
