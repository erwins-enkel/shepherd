// Bundled ci-watch plugin (#2540, epic #2544): failing default-branch CI runs → deterministic
// rules → candidates → classification (#2541: flake probe, JEV, triage) → `ci-failure` issues +
// lifecycle sync (#2542). Off by default: it loads but every tick is a no-op until the operator
// enables it. Plugin code — reaches core only through `ctx`.

import type { PluginContext } from "../../types";
import { createClassifier, registerClassifyRoutes } from "./classify";
import { createFiler, type FileFn } from "./file";
import { buildView, repoFieldId, STRINGS, type Strings } from "./panel";
import { createPoller } from "./poller";
import {
  clampInt,
  dayKey,
  filedToday,
  POLL_MINUTES,
  readRepoConfig,
  readRepoConfigs,
  readSettings,
  readStatus,
  THRESHOLD,
  writeRepoConfig,
  writeSettings,
  type RepoConfig,
  type Settings,
  type ThresholdOverride,
} from "./state";
import { syncFiled } from "./sync";

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

const splitList = (raw: string) =>
  raw
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

/** `glob=N, glob=N` → overrides (N clamped to the threshold range); null when malformed. */
export function parseOverrides(raw: string): ThresholdOverride[] | null {
  const out: ThresholdOverride[] = [];
  for (const part of splitList(raw)) {
    const m = /^(.+?)\s*=\s*(\d+)$/.exec(part);
    if (!m) return null;
    out.push({ glob: m[1]!, threshold: clampInt(Number(m[2]), THRESHOLD.min, THRESHOLD.max, 1) });
  }
  return out;
}

/** Merge the submitted global settings form into `cur`. */
export function applySettingsForm(cur: Settings, b: Body): Settings {
  const next = { ...cur };
  if (typeof b.enabled === "boolean") next.enabled = b.enabled;
  next.pollMinutes = clampInt(b.pollMinutes, POLL_MINUTES.min, POLL_MINUTES.max, cur.pollMinutes);
  if (typeof b.probeSkipGlobs === "string") next.probeSkipGlobs = splitList(b.probeSkipGlobs);
  if (b.locale === "en" || b.locale === "de") next.locale = b.locale;
  return next;
}

/** Merge one repo's submitted form fields (named by {@link repoFieldId}); a string is an error. */
export function applyRepoForm(cur: RepoConfig, b: Body, repo: string, t: Strings) {
  const id = repoFieldId(repo);
  const next = { ...cur };
  if (typeof b[`en.${id}`] === "boolean") next.enabled = b[`en.${id}`] as boolean;
  if (typeof b[`ad.${id}`] === "boolean") next.autoDrain = b[`ad.${id}`] as boolean;
  next.threshold = clampInt(b[`thr.${id}`], THRESHOLD.min, THRESHOLD.max, cur.threshold);
  const raw = b[`ovr.${id}`];
  if (typeof raw === "string") {
    const overrides = parseOverrides(raw);
    if (!overrides) return t.invalidOverrides;
    next.overrides = overrides;
  }
  return next;
}

export default function register(ctx: PluginContext): void {
  const { log } = ctx;
  if (typeof ctx.forge?.runs?.listDefaultBranchRuns !== "function") {
    log.warn("ctx.forge.runs unavailable — ci-watch inert");
    return;
  }
  const canFile =
    typeof ctx.issues?.create === "function" && typeof ctx.sessions?.list === "function";
  if (!canFile) log.warn("ctx.issues / ctx.sessions unavailable — ci-watch won't file issues");
  const file: FileFn = canFile
    ? createFiler({
        state: ctx.state,
        issues: ctx.issues,
        runs: ctx.forge.runs,
        repos: () => ctx.repos.list(),
        now: () => new Date(),
        log,
      })
    : async () => null;
  const stage = createClassifier({
    state: ctx.state,
    runs: ctx.forge.runs,
    judge: typeof ctx.judge?.choice === "function" ? ctx.judge : null,
    agents: ctx.agents,
    file,
    now: () => new Date(),
    log,
  });
  const poller = createPoller({
    state: ctx.state,
    runs: ctx.forge.runs,
    repos: () => ctx.repos.list(),
    forward: (c) => stage.process(c),
    sync: async () =>
      canFile
        ? syncFiled({
            state: ctx.state,
            issues: ctx.issues,
            sessions: ctx.sessions,
            now: () => new Date(),
            log,
          })
        : {},
    now: () => new Date(),
    log,
  });
  const { state } = ctx;
  const usableRepos = () => ctx.repos.list().filter((r) => !r.lightweight);
  const strings = () => STRINGS[readSettings(state).locale];

  function republish(): void {
    if (typeof ctx.publishUI !== "function") return;
    const day = dayKey(new Date());
    ctx.publishUI(
      buildView({
        settings: readSettings(state),
        status: readStatus(state),
        repos: readRepoConfigs(state),
        available: usableRepos(),
        filedToday: (repo) => filedToday(state, repo, day),
        rejected: stage.rejected(),
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
    const repo = String((await readBody(req)).addRepo ?? "");
    if (!usableRepos().some((r) => r.path === repo)) return reply(strings().invalidRepo, 400);
    writeRepoConfig(state, repo, { ...readRepoConfig(state, repo), enabled: true });
    republish();
    return reply(strings().saved);
  });

  ctx.route("POST", "repo/save", async (req) => {
    const b = await readBody(req);
    const repo = String(b.repo ?? "");
    const t = strings();
    if (!usableRepos().some((r) => r.path === repo)) return reply(t.invalidRepo, 400);
    const next = applyRepoForm(readRepoConfig(state, repo), b, repo, t);
    if (typeof next === "string") return reply(next, 400);
    writeRepoConfig(state, repo, next);
    republish();
    return reply(t.saved);
  });

  registerClassifyRoutes(ctx, stage, { onChange: republish, strings });
  ctx.schedule(TICK_MS, async () => {
    await poller.tick();
    if (readSettings(state).enabled) await stage.advance();
    republish();
  });
  republish();
}
