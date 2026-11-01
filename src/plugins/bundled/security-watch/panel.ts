// Settings panel for the security-watch plugin: global settings, poll status, per-repo config,
// the triage rejected list and closed-but-still-open groups. EN + DE copy; the server has no
// operator locale, so the panel carries its own language setting. Panel data is behind operator
// auth, so it may show alert details even for a public repo.

import type { PluginRepo, PluginRepoVisibility, PluginUINode, PluginUIView } from "../../types";
import { DAILY_CAP } from "./rules";
import {
  SEVERITIES,
  type Availability,
  type GroupRecord,
  type Locale,
  type PollStatus,
  type RepoConfig,
  type Settings,
} from "./state";

/** Row caps keep the view under the host's node budget (256). */
const MAX_LIST_ROWS = 10;
/** Shared by the watched list and the add picker. Each row costs its path, label and meta, so
 *  this keeps the view well under the host's 64 KB ceiling; an oversized view is silently
 *  dropped. */
const MAX_LISTED_REPOS = 200;
const REASON_MAX = 300;

export const STRINGS = {
  en: {
    title: "Security Watch",
    intro:
      "Watches open code scanning and Dependabot alerts of enabled repos. Findings are triaged read-only and filed as GitHub issues (label “security-alert”). Never dismisses an alert and never merges. Off until enabled.",
    settings: "Settings",
    enabled: "Enabled",
    pollMinutes: "Poll every (minutes)",
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
    minSeverity: "Minimum severity",
    critical: "Critical",
    high: "High",
    medium: "Medium",
    low: "Low",
    codeScanning: "Code scanning",
    dependabot: "Dependabot",
    includeNonProduction:
      "Include test, generated, library and docs findings, and dev dependencies",
    notRead: "not read",
    visibility: "Visibility",
    publicNotice:
      "This repo is not known to be private. Issues stay redacted, but fixing a finding can still make it public: the fix PR shows the area, critic reviews post to the PR and can state the rule, file and weakness, and the agent can only be told, not forced, to keep details out. Nothing is triaged or filed here until you accept this. To keep critic text off GitHub, turn off the critic for this repo.",
    publicRiskAck: "I accept that findings in this repo can become public",
    saveRepo: "Save repo",
    more: "more not shown",
    add: "Add repository",
    openHint: "Select a repo to edit its settings",
    watching: "watching",
    off: "off",
    pickRepo: "Pick at least one repository.",
    needsAcceptance: "needs acceptance",
    repo: "Repository",
    addButton: "Add and watch",
    rejected: "Rejected by triage",
    noRejected: "No rejected findings.",
    reason: "Reason",
    fileAnyway: "File anyway",
    confirmFile: "File this finding even though triage rejected it?",
    closedOpen: "Closed, alerts still open",
    closedOpenHelp:
      "The issue was closed but its alerts are still open. A rescan may still be pending, or someone closed it on purpose, so Shepherd doesn't file it again by itself.",
    issue: "Issue",
    fileAgain: "File again",
    confirmAgain: "File a new issue for these alerts?",
    // route responses
    saved: "Saved.",
    invalidRepo: "Unknown or local-only repository.",
    pollStarted: "Poll started.",
    filed: "Filed #{n}.",
    duplicate: "Already tracked in #{n}.",
    refused: "Not filed: {code}.",
    deferred: "Accepted; filing is retried on the next tick.",
    needsAck: "Not filed: accept the public-disclosure notice on this repo first.",
    noCandidates: "Not filed: no open finding passes this repo's filters right now.",
  },
  de: {
    title: "Security Watch",
    intro:
      "Beobachtet offene Code-Scanning- und Dependabot-Alerts aktivierter Repos. Funde werden schreibgeschützt triagiert und als GitHub-Issues angelegt (Label „security-alert“). Schließt nie einen Alert und merged nie. Aus, bis es aktiviert wird.",
    settings: "Einstellungen",
    enabled: "Aktiviert",
    pollMinutes: "Abfrage alle (Minuten)",
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
    minSeverity: "Mindest-Schweregrad",
    critical: "Kritisch",
    high: "Hoch",
    medium: "Mittel",
    low: "Niedrig",
    codeScanning: "Code Scanning",
    dependabot: "Dependabot",
    includeNonProduction:
      "Funde in Tests, generiertem Code, Bibliotheken und Doku sowie Dev-Abhängigkeiten einbeziehen",
    notRead: "nicht gelesen",
    visibility: "Sichtbarkeit",
    publicNotice:
      "Dieses Repo ist nicht sicher privat. Issues bleiben geschwärzt, aber das Beheben eines Fundes kann ihn trotzdem öffentlich machen: Der Fix-PR zeigt den Bereich, Critic-Reviews landen im PR und können Regel, Datei und Schwachstelle nennen, und der Agent kann nur angewiesen, nicht gezwungen werden, Details herauszuhalten. Hier wird nichts triagiert oder angelegt, bis du das akzeptierst. Damit Critic-Texte nicht auf GitHub landen, schalte den Critic für dieses Repo aus.",
    publicRiskAck: "Ich akzeptiere, dass Funde in diesem Repo öffentlich werden können",
    saveRepo: "Repo speichern",
    more: "weitere nicht angezeigt",
    add: "Repository hinzufügen",
    openHint: "Repo auswählen, um seine Einstellungen zu bearbeiten",
    watching: "beobachtet",
    off: "aus",
    pickRepo: "Wähle mindestens ein Repository aus.",
    needsAcceptance: "Zustimmung nötig",
    repo: "Repository",
    addButton: "Hinzufügen und beobachten",
    rejected: "Von der Triage abgelehnt",
    noRejected: "Keine abgelehnten Funde.",
    reason: "Grund",
    fileAnyway: "Trotzdem anlegen",
    confirmFile: "Diesen Fund trotz Ablehnung durch die Triage anlegen?",
    closedOpen: "Geschlossen, Alerts noch offen",
    closedOpenHelp:
      "Das Issue wurde geschlossen, seine Alerts sind aber noch offen. Vielleicht steht ein Rescan noch aus, oder jemand hat es bewusst geschlossen. Shepherd legt es deshalb nicht von selbst neu an.",
    issue: "Issue",
    fileAgain: "Erneut anlegen",
    confirmAgain: "Ein neues Issue für diese Alerts anlegen?",
    saved: "Gespeichert.",
    invalidRepo: "Unbekanntes oder rein lokales Repository.",
    pollStarted: "Abfrage gestartet.",
    filed: "Angelegt: #{n}.",
    duplicate: "Bereits erfasst in #{n}.",
    refused: "Nicht angelegt: {code}.",
    deferred: "Angenommen; das Anlegen wird beim nächsten Durchlauf erneut versucht.",
    needsAck: "Nicht angelegt: Akzeptiere zuerst den Hinweis zur Veröffentlichung für dieses Repo.",
    noCandidates: "Nicht angelegt: Gerade besteht kein offener Fund die Filter dieses Repos.",
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
  visibility: (repo: string) => PluginRepoVisibility;
  availability: (repo: string) => Availability;
  rejected: GroupRecord[];
  closedStillOpen: GroupRecord[];
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

const text = (value: string, extra: Record<string, unknown> = {}): PluginUINode => ({
  type: "text",
  props: { value, ...extra },
});
const heading = (value: string) => text(value, { weight: "bold" });
const checkbox = (name: string, label: string, value: boolean): PluginUINode => ({
  type: "checkbox",
  props: { name, label, value },
});
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

function settingsForm(s: Settings, t: Strings): PluginUINode[] {
  return [
    heading(t.settings),
    { type: "callout", props: { text: t.intro, tone: "info" } },
    checkbox("enabled", t.enabled, s.enabled),
    { type: "number", props: { name: "pollMinutes", label: t.pollMinutes, value: s.pollMinutes } },
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
  const last = st.lastPollAt > 0 ? new Date(st.lastPollAt).toISOString() : t.never;
  return [
    heading(t.status),
    {
      type: "key-value",
      props: {
        pairs: [
          { key: t.lastPoll, value: last },
          { key: t.result, value: result || t.none },
          { key: t.lastError, value: st.lastError ?? t.none },
        ],
      },
    },
    button(t.pollNow, "poll-now"),
  ];
}

const repoLabel = (r: PluginRepo) => r.slug ?? r.name;

/** Filterable lists keep plugin order, so sort by what the operator reads. */
const labelOrder = new Intl.Collator("en", { sensitivity: "base", numeric: true }).compare;

function repoName(p: PanelInput, path: string): string {
  const r = p.available.find((x) => x.path === path);
  return r ? repoLabel(r) : path;
}

function repoFacts(p: PanelInput, path: string, t: Strings): PluginUINode {
  const a = p.availability(path);
  return {
    type: "key-value",
    props: {
      pairs: [
        { key: t.visibility, value: p.visibility(path) },
        { key: t.codeScanning, value: a.cs ?? t.notRead },
        { key: t.dependabot, value: a.dep ?? t.notRead },
      ],
    },
  };
}

function repoForm(p: PanelInput, path: string, cfg: RepoConfig, t: Strings): PluginUINode {
  const id = repoFieldId(path);
  const nonPrivate = p.visibility(path) !== "private";
  return {
    type: "stack",
    children: [
      text(`${repoName(p, path)} · ${p.filedToday(path)}/${DAILY_CAP} ${t.filedToday}`, {
        weight: "bold",
      }),
      repoFacts(p, path, t),
      ...(nonPrivate
        ? [
            { type: "callout", props: { text: t.publicNotice, tone: "warning" } },
            checkbox(`ack.${id}`, t.publicRiskAck, cfg.publicRiskAck),
          ]
        : []),
      checkbox(`en.${id}`, t.watch, cfg.enabled),
      checkbox(`ad.${id}`, t.autoDrain, cfg.autoDrain),
      {
        type: "select",
        props: {
          name: `sev.${id}`,
          label: t.minSeverity,
          value: cfg.minSeverity,
          options: SEVERITIES.map((s) => ({ value: s, label: t[s] })),
        },
      },
      checkbox(`cs.${id}`, t.codeScanning, cfg.codeScanning),
      checkbox(`dep.${id}`, t.dependabot, cfg.dependabot),
      checkbox(`np.${id}`, t.includeNonProduction, cfg.includeNonProduction),
      button(t.saveRepo, "repo/save", { submit: true, body: { repo: path } }),
    ],
  };
}

/** Collapsing the form hides the disclosure notice, so a watched repo that files nothing until
 *  it is accepted has to say so in its row. */
function repoMeta(p: PanelInput, path: string, cfg: RepoConfig, t: Strings): string {
  const state = `${cfg.enabled ? t.watching : t.off} · ${p.filedToday(path)}/${DAILY_CAP} ${t.filedToday}`;
  const blocked = cfg.enabled && p.visibility(path) !== "private" && !cfg.publicRiskAck;
  return blocked ? `${t.needsAcceptance} · ${state}` : state;
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

const groupTitle = (g: GroupRecord) => `${g.subject} · ${g.location}`;

function rejectedRow(g: GroupRecord, t: Strings): PluginUINode {
  return {
    type: "stack",
    children: [
      {
        type: "key-value",
        props: {
          pairs: [
            { key: g.repo, value: groupTitle(g) },
            { key: t.reason, value: truncate(g.triage?.reason ?? "", REASON_MAX) },
          ],
        },
      },
      button(t.fileAnyway, "triage/file-anyway", { confirm: t.confirmFile, body: { id: g.key } }),
    ],
  };
}

function closedRow(g: GroupRecord, t: Strings): PluginUINode {
  return {
    type: "stack",
    children: [
      {
        type: "key-value",
        props: {
          pairs: [
            { key: g.repo, value: groupTitle(g) },
            { key: t.issue, value: g.filing?.url ?? t.none },
          ],
        },
      },
      button(t.fileAgain, "triage/file-again", { confirm: t.confirmAgain, body: { id: g.key } }),
    ],
  };
}

function capped(rows: PluginUINode[], t: Strings): PluginUINode[] {
  const extra = rows.length - MAX_LIST_ROWS;
  return [
    ...rows.slice(0, MAX_LIST_ROWS),
    ...(extra > 0 ? [text(`${extra} ${t.more}`, { tone: "muted" })] : []),
  ];
}

function rejectedRows(records: GroupRecord[], t: Strings): PluginUINode[] {
  return [
    heading(t.rejected),
    ...(records.length === 0 ? [text(t.noRejected, { tone: "muted" })] : []),
    ...capped(
      records.map((g) => rejectedRow(g, t)),
      t,
    ),
  ];
}

function closedRows(records: GroupRecord[], t: Strings): PluginUINode[] {
  if (records.length === 0) return [];
  return [
    heading(t.closedOpen),
    text(t.closedOpenHelp, { tone: "muted" }),
    ...capped(
      records.map((g) => closedRow(g, t)),
      t,
    ),
  ];
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
        ...closedRows(p.closedStillOpen, t),
      ],
    },
  };
}
