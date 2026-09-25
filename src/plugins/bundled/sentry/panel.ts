// Settings panel for the Sentry plugin (#2464): connection form, poll status, repo mappings
// (confirmed + suggested + manual add) and the triage rejected list. EN + DE copy; the server
// has no operator locale, so the panel carries its own language setting.

import type { PluginRepo, PluginUINode, PluginUIView } from "../../types";
import { DAILY_CAP } from "./rules";
import type { Locale, Mapping, PollStatus, Settings, Suggestion } from "./state";
import { rejectedPanelNode, type TriageRecord } from "./triage";

/** Row caps keep the view under the host's node budget (256). */
const MAX_MAPPING_ROWS = 20;
const MAX_SUGGESTION_ROWS = 10;
const MAX_REJECTED_ROWS = 15;
/** Host cap on any props array is 500. */
const MAX_REPO_OPTIONS = 400;

export const STRINGS = {
  en: {
    title: "Sentry",
    intro:
      "Polls Sentry for new, escalating or regressed high-priority errors in mapped repos and files a GitHub issue (label “sentry”) after a read-only triage. Off until enabled. Turn Seer off on these projects.",
    connection: "Connection",
    enabled: "Enabled",
    host: "Sentry host",
    org: "Organization slug",
    token: "Internal-integration token",
    tokenSet: "Saved — leave empty to keep",
    tokenUnset: "Scopes: org:read project:read event:read event:write",
    pollMinutes: "Poll every (minutes)",
    minTimesSeen: "Minimum events (times_seen >)",
    language: "Language",
    save: "Save settings",
    status: "Status",
    lastPoll: "Last poll",
    never: "never",
    result: "Last result",
    lastError: "Last error",
    backoff: "Rate-limited until",
    none: "—",
    pollNow: "Poll now",
    mappings: "Repo mappings",
    noMappings: "No repo is mapped to a Sentry project yet.",
    project: "Project",
    filedToday: "Filed today",
    autoDrain: "Auto-drain",
    on: "on",
    off: "off",
    enableAutoDrain: "Auto-drain Sentry issues",
    disableAutoDrain: "Stop auto-draining",
    remove: "Remove",
    confirmRemove: "Remove this mapping? Already filed issues stay.",
    suggestions: "Suggested mappings",
    noSuggestions: "No suggestions. Run detection or add a mapping manually.",
    detect: "Detect mappings",
    confirm: "Confirm",
    orgMismatch: "Configured for a different organization",
    add: "Add mapping manually",
    repo: "Repository",
    addButton: "Add mapping",
    // route responses
    saved: "Saved.",
    invalidHost: "Host must be an http(s) URL.",
    invalidOrg: "Organization must be a Sentry slug.",
    invalidProject: "Project must be a Sentry slug.",
    invalidRepo: "Unknown or local-only repository.",
    unknownMapping: "No such mapping.",
    detected: "Detection finished.",
    pollStarted: "Poll started.",
  },
  de: {
    title: "Sentry",
    intro:
      "Fragt Sentry nach neuen, eskalierenden oder wiederaufgetretenen Fehlern hoher Priorität in zugeordneten Repos ab und legt nach einer schreibgeschützten Triage ein GitHub-Issue an (Label „sentry“). Aus, bis es aktiviert wird. Seer für diese Projekte abschalten.",
    connection: "Verbindung",
    enabled: "Aktiviert",
    host: "Sentry-Host",
    org: "Organisations-Slug",
    token: "Token der internen Integration",
    tokenSet: "Gespeichert — leer lassen zum Beibehalten",
    tokenUnset: "Scopes: org:read project:read event:read event:write",
    pollMinutes: "Abfrage alle (Minuten)",
    minTimesSeen: "Mindestanzahl Ereignisse (times_seen >)",
    language: "Sprache",
    save: "Einstellungen speichern",
    status: "Status",
    lastPoll: "Letzte Abfrage",
    never: "nie",
    result: "Letztes Ergebnis",
    lastError: "Letzter Fehler",
    backoff: "Ratenbegrenzt bis",
    none: "—",
    pollNow: "Jetzt abfragen",
    mappings: "Repo-Zuordnungen",
    noMappings: "Noch kein Repo ist einem Sentry-Projekt zugeordnet.",
    project: "Projekt",
    filedToday: "Heute angelegt",
    autoDrain: "Auto-Drain",
    on: "an",
    off: "aus",
    enableAutoDrain: "Sentry-Issues automatisch abarbeiten",
    disableAutoDrain: "Automatisches Abarbeiten beenden",
    remove: "Entfernen",
    confirmRemove: "Diese Zuordnung entfernen? Bereits angelegte Issues bleiben bestehen.",
    suggestions: "Vorgeschlagene Zuordnungen",
    noSuggestions: "Keine Vorschläge. Erkennung starten oder Zuordnung manuell hinzufügen.",
    detect: "Zuordnungen erkennen",
    confirm: "Bestätigen",
    orgMismatch: "Für eine andere Organisation konfiguriert",
    add: "Zuordnung manuell hinzufügen",
    repo: "Repository",
    addButton: "Zuordnung hinzufügen",
    saved: "Gespeichert.",
    invalidHost: "Host muss eine http(s)-URL sein.",
    invalidOrg: "Organisation muss ein Sentry-Slug sein.",
    invalidProject: "Projekt muss ein Sentry-Slug sein.",
    invalidRepo: "Unbekanntes oder rein lokales Repository.",
    unknownMapping: "Keine solche Zuordnung.",
    detected: "Erkennung abgeschlossen.",
    pollStarted: "Abfrage gestartet.",
  },
} as const satisfies Record<Locale, Record<string, string>>;

export type Strings = (typeof STRINGS)[Locale];

export interface PanelInput {
  settings: Settings;
  hasToken: boolean;
  status: PollStatus;
  mappings: Record<string, Mapping>;
  suggestions: Suggestion[];
  /** Forge-backed repos under the repo root. */
  repos: PluginRepo[];
  filedToday: (repo: string) => number;
  rejected: TriageRecord[];
}

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
const row = (children: PluginUINode[]): PluginUINode => ({
  type: "stack",
  props: { direction: "horizontal" },
  children,
});

function when(ms: number, never: string): string {
  return ms > 0 ? new Date(ms).toISOString() : never;
}

function connection(p: PanelInput, t: Strings): PluginUINode[] {
  const s = p.settings;
  return [
    heading(t.connection),
    { type: "callout", props: { text: t.intro, tone: "info" } },
    { type: "checkbox", props: { name: "enabled", label: t.enabled, value: s.enabled } },
    { type: "text-input", props: { name: "host", label: t.host, value: s.host } },
    { type: "text-input", props: { name: "org", label: t.org, value: s.org } },
    {
      type: "text-input",
      props: {
        name: "token",
        label: t.token,
        secret: true,
        placeholder: p.hasToken ? t.tokenSet : t.tokenUnset,
      },
    },
    { type: "number", props: { name: "pollMinutes", label: t.pollMinutes, value: s.pollMinutes } },
    {
      type: "number",
      props: { name: "minTimesSeen", label: t.minTimesSeen, value: s.minTimesSeen },
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

function status(p: PanelInput, t: Strings): PluginUINode[] {
  const st = p.status;
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
          { key: t.backoff, value: when(st.backoffUntil, t.none) },
        ],
      },
    },
    button(t.pollNow, "poll-now"),
  ];
}

function repoName(p: PanelInput, path: string): string {
  return p.repos.find((r) => r.path === path)?.name ?? path;
}

function mappingRows(p: PanelInput, t: Strings): PluginUINode[] {
  const entries = Object.entries(p.mappings).sort(([a], [b]) => a.localeCompare(b));
  const out: PluginUINode[] = [heading(t.mappings)];
  if (entries.length === 0) out.push(text(t.noMappings, { tone: "muted" }));
  for (const [repo, m] of entries.slice(0, MAX_MAPPING_ROWS)) {
    out.push(
      row([
        {
          type: "key-value",
          props: {
            pairs: [
              { key: repoName(p, repo), value: `${t.project}: ${m.project} (${m.source})` },
              { key: t.filedToday, value: `${p.filedToday(repo)}/${DAILY_CAP}` },
              { key: t.autoDrain, value: m.autoDrain ? t.on : t.off },
            ],
          },
        },
        button(m.autoDrain ? t.disableAutoDrain : t.enableAutoDrain, "mapping/auto-drain", {
          body: { repo, autoDrain: !m.autoDrain },
        }),
        button(t.remove, "mapping/remove", { body: { repo }, confirm: t.confirmRemove }),
      ]),
    );
  }
  return out;
}

function suggestionRows(p: PanelInput, t: Strings): PluginUINode[] {
  const out: PluginUINode[] = [heading(t.suggestions), button(t.detect, "detect")];
  if (p.suggestions.length === 0) out.push(text(t.noSuggestions, { tone: "muted" }));
  for (const sg of p.suggestions.slice(0, MAX_SUGGESTION_ROWS)) {
    const mismatch = sg.org !== null && p.settings.org !== "" && sg.org !== p.settings.org;
    const pairs = [
      { key: repoName(p, sg.repo), value: `${t.project}: ${sg.project} (${sg.source})` },
    ];
    if (mismatch) pairs.push({ key: t.orgMismatch, value: sg.org ?? "" });
    out.push(
      row([
        { type: "key-value", props: { pairs } },
        button(t.confirm, "mapping/confirm", { body: { repo: sg.repo, project: sg.project } }),
      ]),
    );
  }
  return out;
}

function addRow(p: PanelInput, t: Strings): PluginUINode[] {
  const unmapped = p.repos.filter((r) => !p.mappings[r.path]);
  if (unmapped.length === 0) return [];
  return [
    heading(t.add),
    {
      type: "select",
      props: {
        name: "mapRepo",
        label: t.repo,
        options: unmapped.slice(0, MAX_REPO_OPTIONS).map((r) => ({ value: r.path, label: r.name })),
      },
    },
    { type: "text-input", props: { name: "mapProject", label: t.project } },
    button(t.addButton, "mapping/add", { submit: true }),
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
        ...connection(p, t),
        ...status(p, t),
        ...mappingRows(p, t),
        ...suggestionRows(p, t),
        ...addRow(p, t),
        rejectedPanelNode(p.rejected.slice(0, MAX_REJECTED_ROWS), p.settings.locale),
      ],
    },
  };
}
