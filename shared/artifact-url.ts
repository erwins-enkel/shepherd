// claude.ai artifact links (#3875), shared by the server (which records them) and the web UI
// (which renders them). Only the two private forms count; anything else is never an artifact.

const ARTIFACT_URL = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/([A-Za-z0-9_-]{1,64})$/;

/** True for `https://claude.ai/artifact/<id>` or `https://claude.ai/code/artifact/<id>` exactly:
 *  no query, fragment, port, userinfo or trailing slash. */
export function isArtifactUrl(value: unknown): value is string {
  return typeof value === "string" && ARTIFACT_URL.test(value);
}

/** The link without its scheme and with a long id cut in the middle, e.g.
 *  `claude.ai/artifact/GEQx…313`. A value that is no artifact URL comes back unchanged. */
export function shortArtifactUrl(url: string): string {
  const match = ARTIFACT_URL.exec(url);
  if (!match) return url;
  const id = match[1]!;
  const shortId = id.length > 9 ? `${id.slice(0, 4)}…${id.slice(-3)}` : id;
  return `${url.slice("https://".length, url.length - id.length)}${shortId}`;
}
