// How the web terminal opens links. Plain-text URLs (WebLinksAddon) and OSC 8 hyperlinks
// (e.g. Claude Code's `PR #…` status-line badge, whose visible text is only the number)
// open the same way: a plain tap/click opens a new tab.

import type { ILinkHandler } from "@xterm/xterm";

/** Open a terminal link in a new tab; noopener so the opened page can't reach back via
 *  window.opener. */
export function openTerminalLink(uri: string): void {
  window.open(uri, "_blank", "noopener,noreferrer");
}

/** xterm `linkHandler` for OSC 8 hyperlinks. Without one, xterm asks a `confirm()` with a
 *  "could potentially be dangerous" warning before opening. `allowNonHttpProtocols` stays
 *  off, so xterm still drops every link that isn't http(s) before it gets here. */
export const oscLinkHandler: ILinkHandler = {
  activate: (_event, uri) => openTerminalLink(uri),
};
