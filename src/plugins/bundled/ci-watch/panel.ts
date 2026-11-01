// Settings panel for the ci-watch plugin (#2543): global settings, poll status, per-repo
// config (watch, auto-drain, threshold, per-workflow overrides) and the triage rejected list
// with "file anyway". EN + DE copy; the server has no operator locale, so the panel carries its
// own language setting.

import type { PluginRepo, PluginUINode, PluginUIView } from "../../types";
import type { ClassifyRecord } from "./classify";
import { DAILY_CAP } from "./rules";
import type { Locale, PollStatus, RepoConfig, Settings, ThresholdOverride } from "./state";

/** Row caps keep the view under the host's node budget (256). */
const MAX_REJECTED_ROWS = 15;
/** Shared by the watched list and the add picker. Each row costs its path, label and meta, so
 *  this keeps the view well under the host's 64 KB ceiling; an oversized view is silently
 *  dropped. */
const MAX_LISTED_REPOS = 200;
const REASON_MAX = 300;

export const STRINGS = {
  en: {
    title: "CI Watch",
    intro:
      "Watches default-branch CI runs of enabled repos. A job that keeps failing is flake-probed (one rerun), triaged read-only and filed as a GitHub issue (label “ci-failure”). Never merges. Off until enabled.",
    settings: "Settings",
    enabled: "Enabled",
    pollMinutes: "Poll every (minutes)",
    probeSkipGlobs: "Skip the flake probe for workflows (globs, comma-separated)",
    language: "Language",
    save: "Save settings",
    status: "Status",
    lastPoll: "Last poll",
    never: "never",
    result: "Last result",
    lastError: "Last error",
    none: "—",
    pollNow: "Poll now",
    repos: "Repositories",
    noRepos: "No repository is watched yet. Add one below.",
    filedToday: "filed today",
    watch: "Watch this repo",
    autoDrain: "Auto-drain filed issues",
    threshold: "Consecutive failures before filing",
    overrides: "Per-workflow thresholds (glob=N, comma-separated)",
    saveRepo: "Save repo",
    more: "more not shown",
    add: "Add repository",
    openHint: "Select a repo to edit its settings",
    watching: "watching",
    off: "off",
    pickRepo: "Pick at least one repository.",
    repo: "Repository",
    addButton: "Add and watch",
    rejected: "Rejected by triage",
    noRejected: "No rejected CI failures.",
    reason: "Reason",
    run: "Run",
    fileAnyway: "File anyway",
    confirmFile: "File this CI failure even though triage rejected it?",
    // route responses
    saved: "Saved.",
    invalidRepo: "Unknown or local-only repository.",
    invalidOverrides: "Overrides must look like “Eval*=3, nightly=2”.",
    pollStarted: "Poll started.",
    filed: "Filed #{n}.",
    duplicate: "Already tracked in #{n}.",
    fixed: "Not filed: the job is green again.",
    refused: "Not filed: {code}.",
    deferred: "Accepted; filing is retried on the next tick.",
  },
  de: {
    title: "CI Watch",
    intro:
      "Beobachtet CI-Läufe auf dem Default-Branch aktivierter Repos. Ein wiederholt fehlschlagender Job wird auf Flakiness geprüft (ein erneuter Lauf), schreibgeschützt triagiert und als GitHub-Issue angelegt (Label „ci-failure“). Merged nie. Aus, bis es aktiviert wird.",
    settings: "Einstellungen",
    enabled: "Aktiviert",
    pollMinutes: "Abfrage alle (Minuten)",
    probeSkipGlobs: "Flaky-Prüfung für Workflows überspringen (Globs, kommagetrennt)",
    language: "Sprache",
    save: "Einstellungen speichern",
    status: "Status",
    lastPoll: "Letzte Abfrage",
    never: "nie",
    result: "Letztes Ergebnis",
    lastError: "Letzter Fehler",
    none: "—",
    pollNow: "Jetzt abfragen",
    repos: "Repositories",
    noRepos: "Noch wird kein Repository beobachtet. Unten eines hinzufügen.",
    filedToday: "heute angelegt",
    watch: "Dieses Repo beobachten",
    autoDrain: "Angelegte Issues automatisch abarbeiten",
    threshold: "Aufeinanderfolgende Fehlschläge vor dem Anlegen",
    overrides: "Schwellen pro Workflow (Glob=N, kommagetrennt)",
    saveRepo: "Repo speichern",
    more: "weitere nicht angezeigt",
    add: "Repository hinzufügen",
    openHint: "Repo auswählen, um seine Einstellungen zu bearbeiten",
    watching: "beobachtet",
    off: "aus",
    pickRepo: "Wähle mindestens ein Repository aus.",
    repo: "Repository",
    addButton: "Hinzufügen und beobachten",
    rejected: "Von der Triage abgelehnt",
    noRejected: "Keine abgelehnten CI-Fehlschläge.",
    reason: "Grund",
    run: "Lauf",
    fileAnyway: "Trotzdem anlegen",
    confirmFile: "Diesen CI-Fehlschlag trotz Ablehnung durch die Triage anlegen?",
    saved: "Gespeichert.",
    invalidRepo: "Unbekanntes oder rein lokales Repository.",
    invalidOverrides: "Schwellen müssen so aussehen: „Eval*=3, nightly=2“.",
    pollStarted: "Abfrage gestartet.",
    filed: "Angelegt: #{n}.",
    duplicate: "Bereits erfasst in #{n}.",
    fixed: "Nicht angelegt: der Job ist wieder grün.",
    refused: "Nicht angelegt: {code}.",
    deferred: "Angenommen; das Anlegen wird beim nächsten Durchlauf erneut versucht.",
  },
} as const satisfies Record<Locale, Record<string, string>>;

export type Strings = (typeof STRINGS)[Locale];

export interface PanelInput {
  settings: Settings;
  status: PollStatus;
  /** Configured repos by path. */
  repos: Record<string, RepoConfig>;
  /** Forge-backed repos under the repo root. */
  available: PluginRepo[];
  /** The one repo whose form is rendered; every open form would exceed the node budget. */
  openRepo: string | null;
  filedToday: (repo: string) => number;
  rejected: ClassifyRecord[];
}

/** Stable, name-safe field suffix for a repo path (input names reject `/`). FNV-1a 32-bit. */
export function repoFieldId(path: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const formatOverrides = (o: ThresholdOverride[]) =>
  o.map((x) => `${x.glob}=${x.threshold}`).join(", ");

const text = (value: string, extra: Record<string, unknown> = {}): PluginUINode => ({
  type: "text",
  props: { value, ...extra },
});
const heading = (value: string) => text(value, { weight: "bold" });
const button = (
  label: string,
  path: string,
  extra: Record<string, unknown> = {},
): PluginUINode => ({
  type: "action-button",
  props: { label, route: { method: "POST", path }, ...extra },
});

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const when = (ms: number, never: string) => (ms > 0 ? new Date(ms).toISOString() : never);

function settingsForm(s: Settings, t: Strings): PluginUINode[] {
  return [
    heading(t.settings),
    { type: "callout", props: { text: t.intro, tone: "info" } },
    { type: "checkbox", props: { name: "enabled", label: t.enabled, value: s.enabled } },
    { type: "number", props: { name: "pollMinutes", label: t.pollMinutes, value: s.pollMinutes } },
    {
      type: "text-input",
      props: {
        name: "probeSkipGlobs",
        label: t.probeSkipGlobs,
        value: s.probeSkipGlobs.join(", "),
      },
    },
    {
      type: "select",
      props: {
        name: "locale",
        label: t.language,
        value: s.locale,
        options: [
          { value: "en", label: "English" },
          { value: "de", label: "Deutsch" },
        ],
      },
    },
    button(t.save, "settings", { submit: true }),
  ];
}

function status(st: PollStatus, t: Strings): PluginUINode[] {
  const result = Object.entries(st.lastResult)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
  return [
    heading(t.status),
    {
      type: "key-value",
      props: {
        pairs: [
          { key: t.lastPoll, value: when(st.lastPollAt, t.never) },
          { key: t.result, value: result || t.none },
          { key: t.lastError, value: st.lastError ?? t.none },
        ],
      },
    },
    button(t.pollNow, "poll-now"),
  ];
}

/** Picker/heading label: forge `owner/repo`, else the directory name. */
function repoLabel(r: PluginRepo): string {
  return r.slug ?? r.name;
}

/** Filterable lists keep plugin order, so sort by what the operator reads. */
const labelOrder = new Intl.Collator("en", { sensitivity: "base", numeric: true }).compare;

function repoName(p: PanelInput, path: string): string {
  const r = p.available.find((x) => x.path === path);
  return r ? repoLabel(r) : path;
}

function repoForm(p: PanelInput, path: string, cfg: RepoConfig, t: Strings): PluginUINode {
  const id = repoFieldId(path);
  return {
    type: "stack",
    children: [
      text(`${repoName(p, path)} · ${p.filedToday(path)}/${DAILY_CAP} ${t.filedToday}`, {
        weight: "bold",
      }),
      { type: "checkbox", props: { name: `en.${id}`, label: t.watch, value: cfg.enabled } },
      { type: "checkbox", props: { name: `ad.${id}`, label: t.autoDrain, value: cfg.autoDrain } },
      { type: "number", props: { name: `thr.${id}`, label: t.threshold, value: cfg.threshold } },
      {
        type: "text-input",
        props: {
          name: `ovr.${id}`,
          label: t.overrides,
          value: formatOverrides(cfg.overrides),
          placeholder: "Eval*=3",
        },
      },
      button(t.saveRepo, "repo/save", { submit: true, body: { repo: path } }),
    ],
  };
}

function repoMeta(p: PanelInput, path: string, cfg: RepoConfig, t: Strings): string {
  return `${cfg.enabled ? t.watching : t.off} · ${p.filedToday(path)}/${DAILY_CAP} ${t.filedToday}`;
}

function repoRows(p: PanelInput, t: Strings): PluginUINode {
  const entries = Object.entries(p.repos).sort(
    ([a, x], [b, y]) =>
      Number(y.enabled) - Number(x.enabled) || labelOrder(repoName(p, a), repoName(p, b)),
  );
  const open = p.openRepo === null ? undefined : p.repos[p.openRepo];
  const hidden = entries.length - MAX_LISTED_REPOS;
  // Always this one stack: the host keys children by index, so an open form placed beside the
  // add picker would shift it and remount it, losing the operator's picks.
  return {
    type: "stack",
    children: [
      heading(t.repos),
      entries.length === 0
        ? text(t.noRepos, { tone: "muted" })
        : {
            type: "action-list",
            props: {
              label: t.openHint,
              param: "repo",
              route: { method: "POST", path: "repo/open" },
              mono: true,
              items: entries.slice(0, MAX_LISTED_REPOS).map(([path, cfg]) => ({
                value: path,
                label: repoName(p, path),
                meta: repoMeta(p, path, cfg, t),
                current: path === p.openRepo,
              })),
            },
          },
      ...(hidden > 0 ? [text(`${hidden} ${t.more}`, { tone: "muted" })] : []),
      ...(open && p.openRepo !== null ? [repoForm(p, p.openRepo, open, t)] : []),
    ],
  };
}

function addRow(p: PanelInput, t: Strings): PluginUINode[] {
  const unconfigured = p.available
    .filter((r) => !p.repos[r.path])
    .sort((a, b) => labelOrder(repoLabel(a), repoLabel(b)));
  if (unconfigured.length === 0) return [];
  const budget = Math.max(0, MAX_LISTED_REPOS - Object.keys(p.repos).length);
  const listed = unconfigured.slice(0, budget);
  const hidden = unconfigured.length - listed.length;
  return [
    heading(t.add),
    ...(listed.length > 0
      ? [
          {
            type: "multi-select",
            props: {
              name: "addRepos",
              label: t.repo,
              mono: true,
              options: listed.map((r) => ({ value: r.path, label: repoLabel(r) })),
            },
          },
          button(t.addButton, "repo/add", { submit: true }),
        ]
      : []),
    ...(hidden > 0 ? [text(`${hidden} ${t.more}`, { tone: "muted" })] : []),
  ];
}

function rejectedRow(r: ClassifyRecord, t: Strings): PluginUINode {
  return {
    type: "stack",
    children: [
      {
        type: "key-value",
        props: {
          pairs: [
            { key: r.repo, value: `${r.workflowName} / ${r.job}` },
            { key: t.reason, value: truncate(`${r.stage ?? "triage"}: ${r.reason}`, REASON_MAX) },
            { key: t.run, value: r.runUrl },
          ],
        },
      },
      button(t.fileAnyway, "triage/file-anyway", { confirm: t.confirmFile, body: { id: r.id } }),
    ],
  };
}

function rejectedRows(records: ClassifyRecord[], t: Strings): PluginUINode[] {
  const out: PluginUINode[] = [heading(t.rejected)];
  if (records.length === 0) out.push(text(t.noRejected, { tone: "muted" }));
  for (const r of records.slice(0, MAX_REJECTED_ROWS)) out.push(rejectedRow(r, t));
  if (records.length > MAX_REJECTED_ROWS)
    out.push(text(`${records.length - MAX_REJECTED_ROWS} ${t.more}`, { tone: "muted" }));
  return out;
}

export function buildView(p: PanelInput): PluginUIView {
  const t = STRINGS[p.settings.locale];
  return {
    schemaVersion: 1,
    slot: "settings-panel",
    title: t.title,
    root: {
      type: "stack",
      children: [
        ...settingsForm(p.settings, t),
        ...status(p.status, t),
        repoRows(p, t),
        ...addRow(p, t),
        ...rejectedRows(p.rejected, t),
      ],
    },
  };
}
