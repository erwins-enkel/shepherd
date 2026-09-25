// Bundled Sentry plugin (#2464, epic #2467): Sentry → triaged GitHub issues → normal drain.
// Off by default: it loads (so its settings panel is visible) but every tick is a no-op until
// the operator enables it. Plugin code — reaches core only through `ctx`.

import type { PluginContext } from "../../types";
import { isSlug } from "./api";
import { buildView, STRINGS, type Strings } from "./panel";
import { createPoller, type Poller } from "./poller";
import { registerTriageRoutes } from "./triage";
import {
  clampInt,
  dayKey,
  filedToday,
  POLL_MINUTES,
  readMappings,
  readSettings,
  readStatus,
  readSuggestions,
  TIMES_SEEN,
  writeMappings,
  writeSettings,
  writeSuggestions,
  type MappingSource,
  type Settings,
} from "./state";

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

/** `https://host[/path]` without a trailing slash, or null. */
export function normalizeHost(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password || u.search || u.hash) return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/** Merge a submitted settings form into `cur`; a string is an error message. */
export function applySettingsForm(cur: Settings, b: Body, t: Strings): Settings | string {
  const next = { ...cur };
  if (typeof b.enabled === "boolean") next.enabled = b.enabled;
  if (typeof b.host === "string") {
    const host = normalizeHost(b.host);
    if (!host) return t.invalidHost;
    next.host = host;
  }
  if (typeof b.org === "string") {
    const org = b.org.trim();
    if (org && !isSlug(org)) return t.invalidOrg;
    next.org = org;
  }
  next.pollMinutes = clampInt(b.pollMinutes, POLL_MINUTES.min, POLL_MINUTES.max, cur.pollMinutes);
  next.minTimesSeen = clampInt(b.minTimesSeen, TIMES_SEEN.min, TIMES_SEEN.max, cur.minTimesSeen);
  if (b.locale === "en" || b.locale === "de") next.locale = b.locale;
  return next;
}

export default function register(ctx: PluginContext): void {
  const { state, log } = ctx;
  const poller: Poller = createPoller({
    state,
    secrets: ctx.secrets,
    env: process.env,
    issues: ctx.issues,
    agents: ctx.agents,
    repos: () => ctx.repos.list(),
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
    log,
  });

  const usableRepos = () => ctx.repos.list().filter((r) => !r.lightweight);
  const strings = () => STRINGS[readSettings(state).locale];

  function republish(): void {
    const day = dayKey(new Date());
    ctx.publishUI(
      buildView({
        settings: readSettings(state),
        hasToken: poller.hasToken(),
        status: readStatus(state),
        mappings: readMappings(state),
        suggestions: readSuggestions(state),
        repos: usableRepos(),
        filedToday: (repo) => filedToday(state, repo, day),
        rejected: poller.stage.rejected(),
      }),
    );
  }

  /** Run a background job, then refresh the panel; failures are logged, never thrown. */
  function background(what: string, job: () => Promise<unknown>): void {
    job()
      .catch((e: unknown) => log.warn(`${what} failed: ${(e as Error).message}`))
      .finally(republish);
  }

  function setMapping(repo: string, project: string, source: MappingSource): Response {
    const t = strings();
    if (!usableRepos().some((r) => r.path === repo)) return reply(t.invalidRepo, 400);
    if (!isSlug(project)) return reply(t.invalidProject, 400);
    const mappings = readMappings(state);
    mappings[repo] = { project, autoDrain: mappings[repo]?.autoDrain ?? false, source };
    writeMappings(state, mappings);
    writeSuggestions(
      state,
      readSuggestions(state).filter((s) => s.repo !== repo),
    );
    republish();
    return reply(t.saved);
  }

  ctx.route("POST", "settings", async (req) => {
    const b = await readBody(req);
    const cur = readSettings(state);
    const next = applySettingsForm(cur, b, strings());
    if (typeof next === "string") return reply(next, 400);
    if (typeof b.token === "string" && b.token.trim())
      await ctx.secrets.set("token", b.token.trim());
    writeSettings(state, next);
    if (next.enabled && !cur.enabled) background("detect", () => poller.detect());
    republish();
    return reply(STRINGS[next.locale].saved);
  });

  ctx.route("POST", "mapping/add", async (req) => {
    const b = await readBody(req);
    const project = typeof b.mapProject === "string" ? b.mapProject.trim() : "";
    return setMapping(String(b.mapRepo ?? ""), project, "manual");
  });

  ctx.route("POST", "mapping/confirm", async (req) => {
    const b = await readBody(req);
    const repo = String(b.repo ?? "");
    const project = String(b.project ?? "");
    const sg = readSuggestions(state).find((s) => s.repo === repo && s.project === project);
    return setMapping(repo, project, sg?.source ?? "manual");
  });

  ctx.route("POST", "mapping/remove", async (req) => {
    const repo = String((await readBody(req)).repo ?? "");
    const mappings = readMappings(state);
    if (!mappings[repo]) return reply(strings().unknownMapping, 404);
    delete mappings[repo];
    writeMappings(state, mappings);
    republish();
    return reply(strings().saved);
  });

  ctx.route("POST", "mapping/auto-drain", async (req) => {
    const b = await readBody(req);
    const repo = String(b.repo ?? "");
    const mappings = readMappings(state);
    const m = mappings[repo];
    if (!m || typeof b.autoDrain !== "boolean") return reply(strings().unknownMapping, 404);
    mappings[repo] = { ...m, autoDrain: b.autoDrain };
    writeMappings(state, mappings);
    republish();
    return reply(strings().saved);
  });

  ctx.route("POST", "detect", async () => {
    await poller.detect();
    republish();
    return reply(strings().detected);
  });

  ctx.route("POST", "poll-now", () => {
    background("poll", () => poller.poll());
    return reply(strings().pollStarted);
  });

  registerTriageRoutes(ctx, poller.stage, republish);

  ctx.schedule(TICK_MS, async () => {
    await poller.tick();
    republish();
  });
  republish();
}
