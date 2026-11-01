// Bundled security-watch plugin: open code scanning and Dependabot alerts → rules → read-only
// triage → `security-alert` issues (redacted unless the repo reads as private) + lifecycle sync.
// Off by default: it loads, but every tick is a no-op until the operator enables it. Never
// dismisses an alert. Plugin code: reaches core only through `ctx`.

import type { PluginContext } from "../../types";
import { createFiler, type FileOutcome } from "./file";
import { buildView, repoFieldId, STRINGS, type Strings } from "./panel";
import { createPoller } from "./poller";
import {
  clampInt,
  dayKey,
  filedToday,
  POLL_MINUTES,
  readAvailability,
  readRepoConfig,
  readRepoConfigs,
  readSettings,
  readStatus,
  readVisibility,
  SEVERITIES,
  writeRepoConfig,
  writeSettings,
  type RepoConfig,
  type Settings,
} from "./state";
import { syncFiled } from "./sync";
import { createTriage, type FileNowResult } from "./triage";

/** Scheduler granularity; the configured poll interval is enforced inside `tick()`. */
const TICK_MS = 60_000;

type Body = Record<string, unknown>;

async function readBody(req: Request): Promise<Body> {
  try {
    const b: unknown = await req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Body) : {};
  } catch {
    return {};
  }
}

const reply = (msg: string, status = 200) => new Response(msg, { status });

/** Merge the submitted global settings form into `cur`. */
export function applySettingsForm(cur: Settings, b: Body): Settings {
  const next = { ...cur };
  if (typeof b.enabled === "boolean") next.enabled = b.enabled;
  next.pollMinutes = clampInt(b.pollMinutes, POLL_MINUTES.min, POLL_MINUTES.max, cur.pollMinutes);
  if (b.locale === "en" || b.locale === "de") next.locale = b.locale;
  return next;
}

const FLAGS = {
  en: "enabled",
  ad: "autoDrain",
  cs: "codeScanning",
  dep: "dependabot",
  np: "includeNonProduction",
  ack: "publicRiskAck",
} as const;

/** Merge one repo's submitted form fields (named by {@link repoFieldId}). */
export function applyRepoForm(cur: RepoConfig, b: Body, repo: string): RepoConfig {
  const id = repoFieldId(repo);
  const next = { ...cur };
  for (const [prefix, field] of Object.entries(FLAGS) as [
    keyof typeof FLAGS,
    (typeof FLAGS)[keyof typeof FLAGS],
  ][]) {
    const v = b[`${prefix}.${id}`];
    if (typeof v === "boolean") next[field] = v;
  }
  const sev = SEVERITIES.find((s) => s === b[`sev.${id}`]);
  if (sev) next.minSeverity = sev;
  return next;
}

/** Operator-facing reply for a file-now action: the host toasts it verbatim. */
export function fileText(filing: FileOutcome | null, t: Strings): string {
  switch (filing?.status) {
    case "filed":
      return t.filed.replace("{n}", String(filing.number));
    case "duplicate":
      return t.duplicate.replace("{n}", String(filing.number));
    case "refused":
      return t.refused.replace("{code}", filing.code);
    case "needs-ack":
      return t.needsAck;
    case "no-candidates":
      return t.noCandidates;
    default:
      return t.deferred;
  }
}

const NOT_OK_STATUS = { unknown: 404, "not-rejected": 409, "not-closed": 409, busy: 409 } as const;

export default function register(ctx: PluginContext): void {
  const { log, state } = ctx;
  if (typeof ctx.forge?.security?.listCodeScanningAlerts !== "function") {
    log.warn("ctx.forge.security unavailable: security-watch inert");
    return;
  }
  const security = ctx.forge.security;
  const repos = () => ctx.repos.list();
  const now = () => new Date();
  const file = createFiler({ state, issues: ctx.issues, security, repos, now, log });
  const triage = createTriage({ state, agents: ctx.agents, file, now, log });
  const poller = createPoller({
    state,
    security,
    repos,
    forward: (g) => triage.process(g),
    sync: (complete) =>
      syncFiled({ state, issues: ctx.issues, sessions: ctx.sessions, complete, now, log }),
    now,
    log,
  });
  const usableRepos = () => repos().filter((r) => !r.lightweight);
  const strings = () => STRINGS[readSettings(state).locale];

  /** Whose form the panel renders. Transient on purpose: nothing but the view depends on it. */
  let openRepo: string | null = null;

  function republish(): void {
    if (typeof ctx.publishUI !== "function") return;
    const day = dayKey(new Date());
    ctx.publishUI(
      buildView({
        settings: readSettings(state),
        status: readStatus(state),
        repos: readRepoConfigs(state),
        available: usableRepos(),
        openRepo,
        filedToday: (repo) => filedToday(state, repo, day),
        visibility: (repo) => readVisibility(state, repo),
        availability: (repo) => readAvailability(state, repo),
        rejected: triage.rejected(),
        closedStillOpen: triage.closedStillOpen(),
      }),
    );
  }

  ctx.route("POST", "settings", async (req) => {
    const next = applySettingsForm(readSettings(state), await readBody(req));
    writeSettings(state, next);
    republish();
    return reply(STRINGS[next.locale].saved);
  });

  ctx.route("POST", "poll-now", () => {
    void poller
      .poll()
      .catch((e: unknown) => log.warn(`poll failed: ${(e as Error).message}`))
      .finally(republish);
    return reply(strings().pollStarted);
  });

  ctx.route("POST", "repo/add", async (req) => {
    const picked = (await readBody(req)).addRepos;
    const t = strings();
    if (!Array.isArray(picked) || picked.length === 0) return reply(t.pickRepo, 400);
    // Check every path before writing any, so a bad body can't half-apply.
    const usable = new Set(usableRepos().map((r) => r.path));
    if (!picked.every((r) => usable.has(r as string))) return reply(t.invalidRepo, 400);
    const repos = [...new Set(picked as string[])];
    for (const repo of repos) {
      writeRepoConfig(state, repo, { ...readRepoConfig(state, repo), enabled: true });
    }
    if (repos.length === 1) openRepo = repos[0] ?? null;
    republish();
    return reply(t.saved);
  });

  ctx.route("POST", "repo/open", async (req) => {
    const repo = String((await readBody(req)).repo ?? "");
    if (!readRepoConfigs(state)[repo]) return reply(strings().invalidRepo, 400);
    openRepo = openRepo === repo ? null : repo;
    republish();
    return reply("");
  });

  ctx.route("POST", "repo/save", async (req) => {
    const b = await readBody(req);
    const repo = String(b.repo ?? "");
    const t = strings();
    if (!usableRepos().some((r) => r.path === repo)) return reply(t.invalidRepo, 400);
    writeRepoConfig(state, repo, applyRepoForm(readRepoConfig(state, repo), b, repo));
    republish();
    return reply(t.saved);
  });

  function fileRoute(path: string, act: (key: string) => Promise<FileNowResult>): void {
    ctx.route("POST", path, async (req) => {
      const id = (await readBody(req)).id;
      if (typeof id !== "string" || !id) return reply("id required", 400);
      const res = await act(id);
      if (!res.ok) return reply(res.code, NOT_OK_STATUS[res.code]);
      republish();
      return reply(fileText(res.filing, strings()));
    });
  }
  fileRoute("triage/file-anyway", (key) => triage.fileAnyway(key));
  fileRoute("triage/file-again", (key) => triage.fileAgain(key));

  ctx.schedule(TICK_MS, async () => {
    await poller.tick();
    if (readSettings(state).enabled) await triage.advance();
    republish();
  });
  republish();
}
