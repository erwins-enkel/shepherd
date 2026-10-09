import { m } from "#lib/paraglide/messages.js";
import type { AccessToken } from "#lib/types.js";

/** A handoff must not silently point the receiving agent at its own loopback interface. */
export function normalizeAgentServerUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      /^127\./.test(host) ||
      ["0.0.0.0", "[::]", "[::1]", "[::ffff:0:0]"].includes(host) ||
      /^\[::ffff:7f[0-9a-f]{2}:/.test(host)
    )
      return null;
    return url.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

// Paths and other operator-supplied values stay JSON data, even when they contain Markdown fences.
const jsonBlock = (value: unknown) =>
  "```json\n" + JSON.stringify(value, null, 2).replaceAll("`", "\\u0060") + "\n```";

export function buildAccessTokenInstructions(
  serverUrl: string,
  token: string,
  entry: AccessToken,
): string {
  const sections = [
    m.settings_access_instruction_intro(),
    m.settings_access_instruction_network(),
    jsonBlock({
      serverUrl,
      token,
      tokenId: entry.id,
      scope: entry.scope,
      repoPaths: entry.repoPaths,
      expiresAt: entry.expiresAt === null ? null : new Date(entry.expiresAt).toISOString(),
    }),
    m.settings_access_instruction_secret(),
    m.settings_access_instruction_bootstrap(),
  ];
  if (entry.scope === "submit" || entry.scope === "full")
    sections.push(
      m.settings_access_instruction_submit(),
      jsonBlock({
        repoPath: entry.repoPaths?.[0] ?? "<repoPath>",
        baseBranch: "<baseBranch>",
        prompt: m.settings_access_instruction_task(),
      }),
    );
  if (entry.scope === "full") sections.push(m.settings_access_instruction_full());
  sections.push(m.settings_access_instruction_errors());
  return sections.join("\n\n");
}
