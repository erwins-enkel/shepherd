// Vercel Function behind shepherd.run/download/mac (rewritten in vercel.json).
// Redirects to the newest Shepherd for Mac DMG, derived from the Sparkle appcast
// the app itself updates from. The release workflow publishes a Mac release only
// once its DMG, update ZIP and appcast all exist, and advances this feed only
// after that — so the DMG next to the feed's ZIP always exists. Anything
// unexpected falls back to the Mac release list instead of failing.

const FEED_URL =
  "https://raw.githubusercontent.com/erwins-enkel/shepherd/macos-update-feed/appcast.xml";

export const RELEASES_URL = "https://github.com/erwins-enkel/shepherd/releases?q=macos-";

// Open-redirect guard: only this repo's Mac release assets are ever redirected to.
const UPDATE_ZIP =
  /^(https:\/\/github\.com\/erwins-enkel\/shepherd\/releases\/download\/macos-[A-Za-z0-9.-]+\/Shepherd-\d+)\.zip$/;

/** The DMG URL of the feed's highest `sparkle:version`, or null if none is usable. */
export function dmgUrlFromAppcast(xml: string): string | null {
  let newest: { version: number; url: string } | null = null;
  for (const [, body = ""] of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)) {
    const version = /<sparkle:version>\s*(\d+)\s*<\/sparkle:version>/.exec(body)?.[1];
    const url = /<enclosure\b[^>]*?\burl="([^"]*)"/.exec(body)?.[1];
    if (version === undefined || url === undefined) continue;
    if (newest === null || Number(version) > newest.version) {
      newest = { version: Number(version), url };
    }
  }
  const zip = newest && UPDATE_ZIP.exec(newest.url);
  return zip ? `${zip[1]}.dmg` : null;
}

function redirect(location: string, cacheControl: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location, "Cache-Control": cacheControl },
  });
}

export async function GET(): Promise<Response> {
  try {
    const res = await fetch(FEED_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`appcast answered ${res.status}`);
    const dmg = dmgUrlFromAppcast(await res.text());
    if (!dmg) throw new Error("appcast names no usable Mac release asset");
    return redirect(dmg, "public, max-age=0, s-maxage=300, stale-while-revalidate=3600");
  } catch (error) {
    console.error("download-mac: falling back to the release list:", error);
    return redirect(RELEASES_URL, "public, max-age=0, s-maxage=60");
  }
}

// Link checkers and `curl -I` probe with HEAD; answer with the same redirect.
export const HEAD = GET;
