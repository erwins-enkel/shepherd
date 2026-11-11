// Trust tiers for an egress host (#3922): how much friction "Allow for this repo" puts in front of
// a blocked host, and what the extra-hosts editor warns about. Guidance only — the server takes any
// valid hostname; this decides how loudly the UI asks first.
//  - trusted: package registries and vendor CDNs where only the vendor serves content. One click.
//  - risky: classic ways to carry data out. Always an explicit confirm naming the reason.
//  - normal: everything else. A plain confirm.
// The spawn allowlist matches suffixes (src/egress.ts → hostMatchesAllowlist), so risky domains
// match their subdomains too; trusted hosts match exactly so a lookalike never rides along.

export type EgressRiskReason =
  "ip" | "idn" | "paste" | "tunnel" | "oast" | "hosting" | "chatbot" | "subdomain";

export type EgressTrust =
  { tier: "trusted" } | { tier: "risky"; reason: EgressRiskReason } | { tier: "normal" };

const TRUSTED = new Set([
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "static.crates.io",
  "index.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
  "api.nuget.org",
  "nodejs.org",
  "static.rust-lang.org",
  "ghcr.io",
  "registry-1.docker.io",
  "auth.docker.io",
  "production.cloudflare.docker.com",
]);

const RISKY: Record<Exclude<EgressRiskReason, "ip" | "idn">, readonly string[]> = {
  paste: [
    "pastebin.com",
    "paste.ee",
    "hastebin.com",
    "gist.github.com",
    "gist.githubusercontent.com",
    "transfer.sh",
    "file.io",
    "0x0.st",
    "dropbox.com",
    "dropboxusercontent.com",
    "docs.google.com",
    "drive.google.com",
  ],
  tunnel: [
    "ngrok.io",
    "ngrok.app",
    "ngrok-free.app",
    "trycloudflare.com",
    "loca.lt",
    "localtunnel.me",
    "serveo.net",
  ],
  oast: [
    "webhook.site",
    "requestbin.net",
    "pipedream.net",
    "interact.sh",
    "oast.fun",
    "oast.pro",
    "oast.live",
    "oast.site",
    "oast.online",
    "oast.me",
    "oastify.com",
    "burpcollaborator.net",
  ],
  hosting: [
    "vercel.app",
    "workers.dev",
    "pages.dev",
    "cloudfront.net",
    "netlify.app",
    "herokuapp.com",
    "onrender.com",
    "fly.dev",
    "glitch.me",
  ],
  chatbot: ["api.telegram.org", "discord.com", "discordapp.com", "hooks.slack.com"],
  subdomain: [
    "github.io",
    "amazonaws.com",
    "googleapis.com",
    "appspot.com",
    "firebaseapp.com",
    "web.app",
    "azurewebsites.net",
    "blob.core.windows.net",
  ],
};

const IPV4_RE = /^\d+(\.\d+)+$/;

function matches(host: string, domain: string): boolean {
  return host === domain || host.endsWith("." + domain);
}

/** The trust tier of `raw` (trimmed + lowercased); risky wins over everything. */
export function classifyEgressHost(raw: string): EgressTrust {
  const host = raw.trim().toLowerCase();
  if (IPV4_RE.test(host)) return { tier: "risky", reason: "ip" };
  if (host.split(".").some((label) => label.startsWith("xn--")))
    return { tier: "risky", reason: "idn" };
  for (const [reason, domains] of Object.entries(RISKY) as [EgressRiskReason, string[]][]) {
    if (domains.some((d) => matches(host, d))) return { tier: "risky", reason };
  }
  return TRUSTED.has(host) ? { tier: "trusted" } : { tier: "normal" };
}
