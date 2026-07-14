import { SvelteMap } from "svelte/reactivity";
import type {
  Session,
  SessionStatus,
  WsEvent,
  PluginInfo,
  PluginUIView,
  PluginGearItem,
  UsageLimits,
  UpdateStatus,
  HerdrUpdateStatus,
  CodexUpdateStatus,
  CodexUpdateResult,
  PluginUpdatesStatus,
  DiagnosticsSnapshot,
  DiagnosticState,
  StarPromptStatus,
  GitState,
  SessionActivity,
  SubagentEntry,
  BacklogPayload,
  BlockReason,
  DrainStatus,
  AutoMergeStatus,
  BuildQueue,
  Epic,
  CompletedEpic,
  DocAgentOutcome,
  HoldReason,
} from "./types";
import type { BlockState } from "./triage";
import { projectIcons } from "./projectIcons.svelte";
import { reviews, planGates } from "./reviews.svelte";
import { recaps } from "./recaps.svelte";
import { herdDigest } from "./herd-digest.svelte";
import { upNext } from "./up-next.svelte";
import { learnings } from "./learnings.svelte";
import { toasts } from "./toasts.svelte";
import { m } from "$lib/paraglide/messages";
import { buildQueues as buildQueuesStore } from "./buildQueues.svelte";
import { epicDrafts as epicDraftsStore } from "./epic-draft.svelte";
import { postMergeSteps as postMergeStepsStore } from "./post-merge-steps.svelte";

/** Only follow http(s) URLs when opening a link from event-carried data — a `javascript:`
 *  (or other-scheme) value would be an open-redirect / script-execution vector
 *  (CodeQL js/client-side-unvalidated-url-redirection #3). */
function isSafeHttpUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

export class HerdStore {
  sessions = $state<Session[]>([]);
  blocks = $state<Record<string, BlockState>>({});
  connected = $state(false);
  /** Counts every socket that reached `onopen` (1 = the initial page-load connect).
   *  The resync trigger anchors here rather than on a `connected` false→true edge:
   *  a mobile freeze kills the socket WITHOUT ever firing `onclose`, so `connected`
   *  never goes false and an edge-watcher would miss the replacement socket. */
  connectionEpoch = $state(0);
  /** True when THIS tab is focused+visible (the "attended" tier of the attention
   *  ladder — same `active()` notion connect() reports for push suppression). The
   *  ambient tab-signal (tab-signal.svelte.ts) suppresses its title/favicon/badge
   *  while attended and shows them only when the tab is backgrounded. Set on every
   *  presence edge in connect(); false during SSR. */
  attended = $state(false);
  usageLimits = $state<UsageLimits | null>(null);
  update = $state<UpdateStatus | null>(null);
  herdrUpdate = $state<HerdrUpdateStatus | null>(null);
  codexUpdate = $state<CodexUpdateStatus | null>(null);
  /** Installed-plugin update snapshot (informational). Seeded by the
   *  `plugin-update:status` event; drives the plugin-update badge + modal. */
  pluginUpdates = $state<PluginUpdatesStatus | null>(null);
  diagnostics = $state<DiagnosticsSnapshot | null>(null);
  /** Loaded server-side plugins (issue #1124). Empty → Settings → Plugins tab hidden.
   *  Seeded by a bootstrap GET /api/plugins; live-updated by the `plugin:status` event. */
  plugins = $state<PluginInfo[]>([]);
  herdrUpdateLog = $state<string[]>([]);
  herdrUpdateDone = $state<{
    ok: boolean;
    from: string | null;
    to: string | null;
    error?: string;
  } | null>(null);
  codexUpdateLog = $state<string[]>([]);
  codexUpdateDone = $state<CodexUpdateResult | null>(null);
  /** Worst-of diagnostics state; "ok" until a snapshot lands. */
  get diagnosticsOverall(): DiagnosticState {
    return this.diagnostics?.overall ?? "ok";
  }
  /** True when at least one installed plugin has a newer released version. Drives
   *  the plugin-update badge; false until a snapshot lands. */
  get anyPluginUpdate(): boolean {
    return this.pluginUpdates?.updateAvailable ?? false;
  }
  /** Number of tasks currently held (waiting for usage to reset). Updated by `held:changed` WS events. */
  heldCount = $state(0);
  /** "Star us on GitHub?" nudge state; null until the first GET/push. */
  starPrompt = $state<StarPromptStatus | null>(null);
  git = $state<Record<string, GitState>>({});
  /** Live per-session activity signal (heartbeat + current tool), pushed by the server's `session:activity` event. */
  activity = $state<Record<string, SessionActivity>>({});
  /** Live per-session sub-agent roster (sessionId → SubagentEntry[]), pushed by the
   *  server's `session:subagents` event; bootstrapped via GET /api/subagents. An
   *  entry with no `endedAt` is still live. */
  subagents = $state<Record<string, SubagentEntry[]>>({});
  /** Live per-session claude-process liveness (sessionId → alive), pushed by the
   *  server's `session:claude-alive` event. `false` = claude exited and left a
   *  husk shell → the Resume affordance applies; `true` = claude still runs.
   *  Absent = not swept yet (treated as unknown → Resume stays offered). */
  claudeAlive = $state<Record<string, boolean>>({});
  /** Display-only flag (sessionId → true), pushed by the server's
   *  `session:working-blocked` event: the server says this herdr-"blocked"
   *  session is actually mid-turn (herdr latches "blocked" after an answered
   *  dialog). Used ONLY to derive the display status (see display-status.ts) —
   *  never behavioral. Entries drop on working=false and on archive. */
  workingBlocked = $state<Record<string, boolean>>({});
  /** Live per-session hold reasons (sessionId → HoldReason), pushed by the
   *  server's `session:hold` event; bootstrapped via GET /api/holds.
   *  Absent = no hold active for that session. */
  holds = $state<Record<string, HoldReason>>({});
  /** Live per-session preview-listener port (sessionId → port), pushed by the
   *  server's `session:preview` event. A present, non-null value is the single
   *  source of truth for "this agent has a live preview"; absent/null = none. */
  preview = $state<Record<string, number | null>>({});
  /** Live per-session tailscale-serve registration status (sessionId → "ok"|"failed"),
   *  pushed by the server's `session:preview-serve` event and merged from the
   *  /api/preview bootstrap. "failed" → the preview is reachable on loopback only
   *  (Tailscale exposure didn't register); surfaced as a degraded Preview badge/pane.
   *  Absent = not managed (auto off / tailscale absent) or no mapping yet. */
  previewServe = $state<Record<string, "ok" | "failed">>({});
  /** Live backlog overview, pushed over the WS by the server's warm poller
   *  (`backlog:update`, ~every 45s). Stays null until the first push arrives —
   *  the page's instant first paint comes from a separate one-shot GET
   *  /api/backlog into page-local state, not from here; each push thereafter
   *  keeps the open dashboard live. */
  backlog = $state<BacklogPayload | null>(null);
  /** Live drain status keyed by repoPath; bootstrapped via GET /api/drain,
   *  updated in real-time by the `drain:status` WS event. */
  drain = $state<Record<string, DrainStatus>>({});
  /** Live automerge status keyed by repoPath; bootstrapped via GET /api/automerge,
   *  updated in real-time by the `automerge:status` WS event. */
  autoMerge = $state<Record<string, AutoMergeStatus>>({});
  /** Live build queue keyed by sessionId; bootstrapped via GET /api/sessions/:id/queue,
   *  updated in real-time by the `queue:update` WS event. */
  buildQueues = $state<Record<string, BuildQueue>>({});
  /** Live epic state keyed by `${repoPath}#${parentIssueNumber}`;
   *  updated in real-time by the `epic:update` WS event. */
  epics = $state<Record<string, Epic>>({});
  /** Completed-epic records (newest first); bootstrapped via GET /api/epics/completed,
   *  kept live by the `epic:completed` / `epic:completed-cleared` WS events. */
  completedEpics = $state<CompletedEpic[]>([]);
  /** Whether the PR-gated doc agent feature is enabled; set from loadSettings(). Gates the doc-agent toast. */
  docAgentEnabled = $state(false);
  /** Reactive signal set on each `doc-agent:done` WS event; Task 3 components watch this to re-fetch runs. */
  docAgentDone = $state<{ repoPath: string; url: string | null; outcome: DocAgentOutcome } | null>(
    null,
  );
  /** true once the user has confirmed an update; cleared by the reload it triggers */
  updating = $state(false);
  /** SHA we booted on; a different `current` after an update means a fresh build is live */
  private runningVersion: string | null = null;
  /** toast id keyed by sessionId for active draft-reconcile error alerts; used to dismiss on success. */
  private draftReconcileToastIds = new SvelteMap<string, number>();

  setAll(list: Session[]) {
    this.sessions = list;
  }
  setGit(map: Record<string, GitState>) {
    this.git = map;
  }
  setActivity(map: Record<string, SessionActivity>) {
    this.activity = map;
  }
  /** Seed (or replace) the sub-agent roster map after a bootstrap GET. */
  setSubagents(map: Record<string, SubagentEntry[]>) {
    this.subagents = map;
  }
  /** Seed (or replace) the claude-liveness map after a bootstrap GET. */
  setClaudeAlive(map: Record<string, boolean>) {
    this.claudeAlive = map;
  }
  /** Seed (or replace) the working-while-blocked flag map after a bootstrap GET. */
  setWorkingBlocked(map: Record<string, boolean>) {
    this.workingBlocked = map;
  }
  /** Seed the per-session block map after a bootstrap GET /api/blocks. Blocks are
   *  edge-emitted via `session:block`, so a fresh load / push-then-open would otherwise
   *  show no block (and no MCP-auth affordance) until the next re-classify. `since` is
   *  best-effort (bootstrap can't recover the original block time). Live events keep the
   *  earlier `since` via `setBlock`. */
  setBlocks(map: Record<string, BlockReason>) {
    const now = Date.now();
    this.blocks = Object.fromEntries(
      Object.entries(map).map(([id, reason]) => [id, { reason, since: now }]),
    );
  }
  /** Seed (or replace) the hold-reason map after a bootstrap GET. */
  setHolds(map: Record<string, HoldReason>): void {
    this.holds = map;
  }
  /** Seed (or replace) the loaded-plugins list after the bootstrap GET /api/plugins. */
  setPlugins(list: PluginInfo[]): void {
    this.plugins = list;
  }
  /** Live `plugin:status` push: update the matching plugin's core-derived health +
   *  published blob in place. Extracted from apply() for the complexity gate. */
  private applyPluginStatus(data: { id: string; health: PluginInfo["health"]; status: unknown }) {
    const i = this.plugins.findIndex((p) => p.id === data.id);
    if (i === -1) return; // unknown id (pre-bootstrap race) — the GET seed will catch up
    this.plugins = this.plugins.map((p) =>
      p.id === data.id ? { ...p, health: data.health, status: data.status } : p,
    );
  }
  /** Live `plugin:ui` push: update the matching plugin's descriptor view in place.
   *  Mirrors applyPluginStatus, including the pre-bootstrap unknown-id no-op. */
  private applyPluginUi(data: { id: string; ui: PluginUIView | null }) {
    const i = this.plugins.findIndex((p) => p.id === data.id);
    if (i === -1) return; // unknown id (pre-bootstrap race) — the GET seed will catch up
    this.plugins = this.plugins.map((p) => (p.id === data.id ? { ...p, ui: data.ui } : p));
  }
  /** Live `plugin:gear` push: update the matching plugin's gear-menu item in place.
   *  Mirrors applyPluginUi, including the pre-bootstrap unknown-id no-op. */
  private applyPluginGear(data: { id: string; gearItem: PluginGearItem | null }) {
    const i = this.plugins.findIndex((p) => p.id === data.id);
    if (i === -1) return; // unknown id (pre-bootstrap race) — the GET seed will catch up
    this.plugins = this.plugins.map((p) =>
      p.id === data.id ? { ...p, gearItem: data.gearItem } : p,
    );
  }
  /** Seed (or replace) the preview-port map after a bootstrap GET. */
  setPreview(map: Record<string, number | null>) {
    this.preview = map;
  }
  /** Seed (or replace) the preview-serve map after a bootstrap GET. */
  setPreviewServe(map: Record<string, "ok" | "failed">) {
    this.previewServe = map;
  }
  setDrain(list: DrainStatus[]) {
    this.drain = Object.fromEntries(list.map((d) => [d.repoPath, d]));
  }
  setAutoMerge(list: AutoMergeStatus[]) {
    this.autoMerge = Object.fromEntries(list.map((s) => [s.repoPath, s]));
  }
  /** Seed (or replace) the build queue for a session — called after a bootstrap GET. */
  setBuildQueue(q: BuildQueue) {
    this.buildQueues = { ...this.buildQueues, [q.sessionId]: q };
    buildQueuesStore.upsert(q);
  }
  /** Bulk-replace the build queue map — called after a resync GET /api/queues. */
  setBuildQueues(map: Record<string, BuildQueue>) {
    this.buildQueues = map;
    buildQueuesStore.seed(map);
  }
  /** Upsert an epic — called after GET/PUT /api/epic or on `epic:update` WS push.
   *  FINISHED epics (idle + every child merged — the drain's own auto-complete
   *  condition, and the shape of its final post-completion emit) are PRUNED instead
   *  of upserted: `epics` is otherwise append-only, and +page's resync() re-fetches
   *  every key on each wake/socket-reopen, so a long-lived tab would issue one
   *  GET /api/epic per epic EVER seen, forever. The prune also self-cleans on the
   *  wake path — a resync re-pull of a since-completed epic drops its key rather
   *  than refreshing it. Display of completed epics is unaffected: the backlog
   *  grouping keys off drain.epicParent and IssuesPanel falls back to its own
   *  one-shot fetch when the live record is absent. */
  setEpic(e: Epic) {
    const key = `${e.repoPath}#${e.parentIssueNumber}`;
    const finished =
      e.run.status === "idle" &&
      e.children.length > 0 &&
      e.children.every((c) => c.state === "merged");
    if (finished) {
      this.dropEpic(key);
      return;
    }
    this.epics = { ...this.epics, [key]: e };
  }
  /** Remove a live epic record (no-op when absent). */
  private dropEpic(key: string) {
    if (!(key in this.epics)) return;
    const next = { ...this.epics };
    delete next[key];
    this.epics = next;
  }
  /** Seed (or replace) the completed-epics list after a bootstrap GET. */
  seedCompletedEpics(list: CompletedEpic[]): void {
    this.completedEpics = list;
  }
  setUsageLimits(l: UsageLimits) {
    this.usageLimits = l;
  }
  byId(id: string) {
    return this.sessions.find((s) => s.id === id);
  }

  /** Record the user's confirmation; the next status carrying a new SHA reloads. */
  beginUpdate() {
    this.updating = true;
  }

  setUpdate(u: UpdateStatus) {
    // the first status we ever see pins the version the page was loaded against
    if (this.runningVersion === null) this.runningVersion = u.current;
    // after a confirmed update the server returns on a new SHA → reload so the
    // browser (e.g. the phone) picks up the freshly built UI assets
    if (
      this.updating &&
      u.current &&
      this.runningVersion &&
      u.current !== this.runningVersion &&
      typeof location !== "undefined"
    ) {
      location.reload();
      return;
    }
    this.update = u;
  }

  /** Set or clear a session's block (null reason clears). Extracted from apply()
   *  to keep that dispatch switch under the complexity gate. */
  private setBlock(id: string, reason: BlockReason | null) {
    if (!reason) {
      this.blocks = dropKey(this.blocks, id);
      return;
    }
    const prev = this.blocks[id];
    this.blocks = { ...this.blocks, [id]: { reason, since: prev?.since ?? Date.now() } };
  }

  /** Set or clear a session's live preview-listener port (null tears the entry
   *  down so `preview[id] != null` reads false and the badge/tab clear). Extracted
   *  from apply() to keep that dispatch switch under the complexity gate. */
  private setPreviewPort(id: string, port: number | null) {
    if (port == null) this.preview = dropKey(this.preview, id);
    else this.preview = { ...this.preview, [id]: port };
  }

  /** Set or clear a session's tailscale-serve registration status. null drops the
   *  entry (not managed or cleared); "ok"/"failed" merges it in. Extracted from
   *  apply() to keep that dispatch switch under the complexity gate. */
  private setServe(id: string, serve: "ok" | "failed" | null) {
    if (serve == null) this.previewServe = dropKey(this.previewServe, id);
    else this.previewServe = { ...this.previewServe, [id]: serve };
  }

  /** Set or clear a session's working-while-blocked display flag. false drops the
   *  entry (keeps the map small — absent reads the same as false). Extracted from
   *  apply() to keep that dispatch switch under the complexity gate. */
  private setWorkingBlockedFlag(id: string, working: boolean) {
    if (working) this.workingBlocked = { ...this.workingBlocked, [id]: true };
    else this.workingBlocked = dropKey(this.workingBlocked, id);
  }

  /** Patch a session's name + branch, then surface the rename (esp. the async
   *  namer's auto-rename, which lands while the agent is already working) so the
   *  row changing under the user is explained. Toasts only when the visible name
   *  actually changed: the contingency path (syncWorktreeBranch) re-emits with an
   *  unchanged name when only the branch moved, which would otherwise read as a
   *  "Renamed to <same name>" non-event. Extracted from apply() to keep that
   *  dispatch switch under the complexity gate. */
  private applyRenamed(id: string, name: string, branch: string | null) {
    const prevName = this.byId(id)?.name;
    this.patchSession(id, { name, branch });
    if (prevName !== undefined && prevName !== name) toasts.info(m.toast_renamed({ name }));
  }

  /** Mutate a session's fields in place. `sessions` is a deeply-reactive $state
   *  proxy, so property writes give fine-grained updates without replacing the
   *  array (which would re-run every keyed {#each} row for a one-session
   *  change). Full-array replacement is reserved for events that change the SET
   *  of sessions (session:new / session:archived / setAll). */
  private patchSession(id: string, patch: Partial<Session>) {
    const s = this.byId(id);
    if (s) Object.assign(s, patch);
  }

  /** Apply a session:status push. Merges the turn-end scratchpad flag (#1164) only when this
   *  push carries it (idle/done transitions); the undefined guard stops a status-only push
   *  (e.g. → running) from clobbering the live flag back to falsy. */
  private applyStatus(
    d: { id: string; status: SessionStatus; hasScratchpadFiles?: boolean } & Partial<Session>,
  ) {
    const patch: Partial<Session> = { ...d, status: d.status };
    if (d.hasScratchpadFiles !== undefined) patch.hasScratchpadFiles = d.hasScratchpadFiles;
    this.patchSession(d.id, patch);
  }

  /** Append a session on session:new, ignoring a duplicate id (pushes can race the bootstrap). */
  private addSession(s: Session) {
    if (!this.byId(s.id)) this.sessions = [...this.sessions, s];
  }

  apply(ev: WsEvent) {
    switch (ev.event) {
      case "session:new":
        this.addSession(ev.data);
        break;
      case "session:status":
        this.applyStatus(ev.data);
        break;
      case "session:renamed":
        this.applyRenamed(ev.data.id, ev.data.name, ev.data.branch);
        break;
      case "session:ready":
        this.patchSession(ev.data.id, { readyToMerge: ev.data.ready });
        break;
      case "session:merging":
        this.patchSession(ev.data.id, {
          mergingSince: ev.data.since,
          mergingTrainId: ev.data.trainId,
        });
        break;
      case "session:autopilot":
        this.patchSession(ev.data.id, {
          autopilotPaused: ev.data.paused,
          autopilotComplete: ev.data.complete,
          autopilotQuestion: ev.data.question,
          autopilotEnabled: ev.data.enabled,
        });
        break;
      case "session:automerge":
        this.patchSession(ev.data.id, { autoMergeEnabled: ev.data.enabled });
        break;
      case "session:experiment":
        // The variant carries its experiment in its session:new payload; this patches the
        // ALREADY-VISIBLE original (or any member) when it's (back-)linked into a group so its
        // card joins the experiment grouping live, without a reload.
        this.patchSession(ev.data.id, {
          experimentId: ev.data.experimentId,
          experimentRole: ev.data.experimentRole,
        });
        break;
      case "session:archived":
        this.sessions = this.sessions.filter((s) => s.id !== ev.data.id);
        this.blocks = dropKey(this.blocks, ev.data.id);
        this.git = dropKey(this.git, ev.data.id);
        this.activity = dropKey(this.activity, ev.data.id);
        this.subagents = dropKey(this.subagents, ev.data.id);
        this.claudeAlive = dropKey(this.claudeAlive, ev.data.id);
        this.workingBlocked = dropKey(this.workingBlocked, ev.data.id);
        this.holds = dropKey(this.holds, ev.data.id);
        this.preview = dropKey(this.preview, ev.data.id);
        this.previewServe = dropKey(this.previewServe, ev.data.id);
        reviews.drop(ev.data.id);
        planGates.drop(ev.data.id);
        // Drop the recap from the live cache on archive. DELIBERATELY re-populated later:
        // the post-archive `session:recap` finalize event re-adds this id (and the Done
        // lens calls recaps.load() to repopulate archived recaps from /api/recaps). This is
        // SAFE because the live Herd renders from the `sessions` array (which dropped the
        // session above), so a lingering recap entry can't resurrect a live row — and the
        // Done lens WANTS the recap. Do NOT "fix" the re-add, or the Done lens goes blank.
        recaps.drop(ev.data.id);
        this.clearDraftReconcileToast(ev.data.id);
        break;
      case "session:working-blocked":
        this.setWorkingBlockedFlag(ev.data.id, ev.data.working);
        break;
      case "session:preview":
        this.setPreviewPort(ev.data.id, ev.data.previewPort);
        break;
      case "session:preview-serve":
        this.setServe(ev.data.id, ev.data.serve);
        break;
      case "session:block":
        this.setBlock(ev.data.id, ev.data.block);
        break;
      case "session:hold":
        if (ev.data.hold) this.holds = { ...this.holds, [ev.data.id]: ev.data.hold };
        else this.holds = dropKey(this.holds, ev.data.id);
        break;
      default:
        // Notification-toast, simple data-update, review/plan-gate, and app-global events are
        // handled out of line to keep this dispatch switch under the complexity gate.
        if (
          !this.applyNotificationEvent(ev) &&
          !this.applySessionDataEvent(ev) &&
          !this.applySessionCardEvent(ev)
        )
          this.applyGlobalEvent(ev);
        break;
    }
  }

  /** Handle the operator-notification WS events — each surfaces a keyed, alert-level toast and
   *  mutates no store state. Extracted from apply() to keep that dispatch switch under the
   *  complexity gate. Returns true when `ev` was handled. */
  private applyNotificationEvent(ev: WsEvent): boolean {
    switch (ev.event) {
      case "session:egress-drop":
        toasts.info(m.toast_egress_drop({ host: ev.data.host }), {
          key: "egress-drop-" + ev.data.id,
          alert: true,
        });
        return true;
      case "session:uploads-dropped":
        toasts.info(m.toast_uploads_dropped({ count: ev.data.count }), {
          key: "uploads-dropped-" + ev.data.id,
          alert: true,
        });
        return true;
      case "session:injection-detected":
        toasts.info(m.toast_injection_detected({ count: ev.data.count }), {
          key: "injection-" + ev.data.id,
          alert: true,
        });
        return true;
      case "repo:untrusted-author":
        toasts.info(m.toast_untrusted_author({ issue: ev.data.issue }), {
          key: "untrusted-author-" + ev.data.repoPath + "-" + ev.data.issue,
          alert: true,
        });
        return true;
      default:
        return false;
    }
  }

  /** Handle the simple per-session data-update WS events (git, activity, subagents,
   *  claude-alive, halt) — extracted from apply() to keep that dispatch switch under
   *  the complexity gate. Returns true when `ev` was handled. */
  private applySessionDataEvent(ev: WsEvent): boolean {
    switch (ev.event) {
      case "session:git":
        this.git = { ...this.git, [ev.data.id]: ev.data.git };
        return true;
      case "session:activity":
        this.activity = { ...this.activity, [ev.data.id]: ev.data.activity };
        return true;
      case "session:subagents":
        this.subagents = { ...this.subagents, [ev.data.id]: ev.data.subagents };
        return true;
      case "session:claude-alive":
        this.claudeAlive = { ...this.claudeAlive, [ev.data.id]: ev.data.claudeAlive };
        return true;
      case "session:halt":
        this.patchSession(ev.data.id, {
          haltReason: ev.data.haltReason,
          haltedAt: ev.data.haltedAt,
        });
        return true;
      case "session:manual-steps":
        this.patchSession(ev.data.id, {
          manualSteps: ev.data.manualSteps,
          // ackedAt rides along on the ack broadcast (#1060) so the CTA clears on every client;
          // the P1 detection emit omits it (steps changed, ack unchanged) → leave it untouched.
          ...(ev.data.manualStepsAckedAt !== undefined
            ? { manualStepsAckedAt: ev.data.manualStepsAckedAt }
            : {}),
        });
        return true;
      default:
        return false;
    }
  }

  /** Handle the review + plan-gate + recap WS events, all of which delegate to the
   *  `reviews`/`planGates`/`recaps` sub-stores. Split out of apply() so its dispatch
   *  switch stays under the complexity gate. Returns true if `ev` was handled. */
  private applySessionCardEvent(ev: WsEvent): boolean {
    switch (ev.event) {
      case "session:recap":
        recaps.apply(ev.data);
        return true;
      case "session:review":
        reviews.apply(ev.data);
        return true;
      case "session:reviewing":
        reviews.setReviewing(ev.data.id, ev.data.reviewing, ev.data.env);
        return true;
      case "session:critic-activity":
        reviews.setActivity(ev.data.id, ev.data.summary);
        return true;
      case "session:plangate":
        // Emitted two ways: a fresh verdict carries `gate`; a phase flip carries `planPhase`.
        if (ev.data.gate) planGates.apply(ev.data.id, ev.data.gate);
        if (ev.data.planPhase) this.patchSession(ev.data.id, { planPhase: ev.data.planPhase });
        return true;
      case "session:plangate-reviewing":
        planGates.applyReviewing(ev.data.id, ev.data.reviewing, ev.data.env);
        return true;
      case "session:plangate-activity":
        planGates.setActivity(ev.data.id, ev.data.summary);
        return true;
      default:
        return false;
    }
  }

  /** Handle the three herdr self-update channel events (status / log / done). Returns true
   *  when it handled `ev`, false otherwise — split out of applyGlobalEvent so that dispatch
   *  switch stays under the complexity gate. */
  private applyHerdrUpdateEvent(ev: WsEvent): boolean {
    switch (ev.event) {
      case "herdr-update:status":
        this.herdrUpdate = ev.data;
        return true;
      case "herdr-update:log":
        this.herdrUpdateLog = [...this.herdrUpdateLog, ev.data.line].slice(-200);
        return true;
      case "herdr-update:done":
        this.herdrUpdateDone = ev.data as {
          ok: boolean;
          from: string | null;
          to: string | null;
          error?: string;
        };
        return true;
      default:
        return false;
    }
  }

  /** Handle the `codex-update:*` WS events (status / log / done), mirroring
   *  applyHerdrUpdateEvent. Split out so the dispatch switch stays under the
   *  complexity gate. Returns true if handled. */
  private applyCodexUpdateEvent(ev: WsEvent): boolean {
    switch (ev.event) {
      case "codex-update:status":
        this.codexUpdate = ev.data;
        return true;
      case "codex-update:log":
        this.codexUpdateLog = [...this.codexUpdateLog, ev.data.line].slice(-200);
        return true;
      case "codex-update:done":
        this.codexUpdateDone = ev.data;
        return true;
      default:
        return false;
    }
  }

  /** Handle the `doc-agent:done` WS event. Sets the reactive `docAgentDone` signal and,
   *  when `docAgentEnabled` is true, fires an outcome-keyed toast. Returns true if handled. */
  private applyDocAgentEvent(ev: WsEvent): boolean {
    if (ev.event !== "doc-agent:done") return false;
    this.docAgentDone = ev.data;
    if (!this.docAgentEnabled) return true;
    const repo = ev.data.repoPath.split("/").pop() ?? ev.data.repoPath;
    const key = `doc-agent-done:${ev.data.repoPath}`;
    if (ev.data.outcome === "pr") {
      const url = ev.data.url;
      // Only wire the "view PR" action for a validated http(s) URL — never open an
      // unvalidated event-carried value (CodeQL js/client-side-unvalidated-url-redirection #3).
      const safeUrl = url != null && isSafeHttpUrl(url) ? url : null;
      toasts.info(m.docagent_toast_pr_opened({ repo }), {
        key,
        ...(safeUrl != null
          ? {
              action: {
                label: m.docagent_toast_view_pr(),
                run: () => window.open(safeUrl, "_blank", "noopener"),
              },
            }
          : {}),
      });
    } else if (ev.data.outcome === "observe") {
      toasts.info(m.docagent_toast_observe({ repo }), { key });
    } else if (ev.data.outcome === "error") {
      toasts.info(m.docagent_toast_error({ repo }), {
        key: `doc-agent-error:${ev.data.repoPath}`,
        alert: true,
      });
    } else {
      toasts.info(m.docagent_toast_no_changes({ repo }), { key });
    }
    return true;
  }

  /** Handle the epic lifecycle WS events (update / completed / completed-cleared).
   *  Split out of applyGlobalEvent so its dispatch switch stays under the complexity
   *  gate (mirrors applyHerdrUpdateEvent / applyDocAgentEvent). Returns true if handled. */
  private applyEpicEvent(ev: WsEvent): boolean {
    switch (ev.event) {
      case "epic:update":
        this.setEpic(ev.data);
        return true;
      case "epic:completed": {
        const key = `${ev.data.repoPath}#${ev.data.parentIssueNumber}`;
        // The run is over — drop the live record so the append-only `epics` map
        // doesn't pin a resync re-fetch for it forever (see setEpic). The drain's
        // trailing final epic:update (idle, all merged) is swallowed by setEpic's
        // finished-prune, so it can't resurrect the key.
        this.dropEpic(key);
        const filtered = this.completedEpics.filter(
          (e) => `${e.repoPath}#${e.parentIssueNumber}` !== key,
        );
        this.completedEpics = [ev.data, ...filtered];
        // A merged landing state is the operator's own land action resolving (#1039), not a fresh
        // completion — confirm the land instead of re-announcing "complete". Distinct dedupe-key
        // namespace (epic-landed:) so it never collides with the completion toast's key.
        if (ev.data.landingState === "merged") {
          toasts.info(m.landed_epic_toast({ number: ev.data.parentIssueNumber }), {
            key: `epic-landed:${ev.data.repoPath}#${ev.data.parentIssueNumber}`,
          });
        } else {
          toasts.info(
            m.completed_epic_toast({
              number: ev.data.parentIssueNumber,
              count: ev.data.children.length,
            }),
            { key: `epic-complete:${ev.data.repoPath}#${ev.data.parentIssueNumber}` },
          );
        }
        return true;
      }
      case "epic:completed-cleared":
        this.completedEpics = this.completedEpics.filter(
          (e) =>
            e.repoPath !== ev.data.repoPath || e.parentIssueNumber !== ev.data.parentIssueNumber,
        );
        return true;
      default:
        return false;
    }
  }

  /** Handle the app-global (non per-session-row) WS events: usage limits, the
   *  self/herdr update channels, project icons, learnings, backlog + drain.
   *  Split out of apply() so its dispatch switch stays under the complexity gate. */
  /** Singleton status/snapshot pushes (usage, self-update, diagnostics, plugins,
   *  star-prompt). Extracted from applyGlobalEvent to keep that dispatch under the
   *  complexity gate. Returns true when handled. */
  private applyStatusEvent(ev: WsEvent): boolean {
    switch (ev.event) {
      case "usage:limits":
        this.usageLimits = ev.data;
        return true;
      case "update:status":
        this.setUpdate(ev.data);
        return true;
      case "diagnostics:status":
        this.diagnostics = ev.data;
        return true;
      case "plugin:status":
        this.applyPluginStatus(ev.data);
        return true;
      case "plugin:ui":
        this.applyPluginUi(ev.data);
        return true;
      case "plugin:gear":
        this.applyPluginGear(ev.data);
        return true;
      case "star-prompt:status":
        this.starPrompt = ev.data;
        return true;
      case "plugin-update:status":
        this.pluginUpdates = ev.data;
        return true;
    }
    return false;
  }

  private applyGlobalEvent(ev: WsEvent) {
    if (this.applyHerdrUpdateEvent(ev)) return;
    if (this.applyCodexUpdateEvent(ev)) return;
    if (this.applyDocAgentEvent(ev)) return;
    if (this.applyEpicEvent(ev)) return;
    if (this.applyStatusEvent(ev)) return;
    switch (ev.event) {
      case "project-icons:update":
        projectIcons.apply(ev.data);
        break;
      case "learnings:update":
        learnings.apply(ev.data);
        break;
      case "herd:digest":
        herdDigest.apply(ev.data);
        break;
      case "upnext:snapshot":
        upNext.apply(ev.data);
        break;
      case "backlog:update":
        this.backlog = ev.data;
        break;
      case "drain:status":
        this.drain = { ...this.drain, [ev.data.repoPath]: ev.data };
        break;
      case "automerge:status":
        this.autoMerge = { ...this.autoMerge, [ev.data.repoPath]: ev.data };
        break;
      case "queue:update":
        this.buildQueues = { ...this.buildQueues, [ev.data.sessionId]: ev.data };
        buildQueuesStore.upsert(ev.data);
        break;
      case "session:epic-draft":
        epicDraftsStore.upsert(ev.data);
        break;
      case "post-merge-steps:changed":
        // Durable post-merge steps (#1061): refresh the Owed lens store if it's been opened.
        void postMergeStepsStore.refreshIfLoaded();
        break;
      case "held:changed":
        this.heldCount = ev.data.count;
        break;
      case "halt:done":
        // Fleet-wide stop landed: confirm the reach to EVERY connected operator (the
        // event fans out to all clients, not just the one who fired it). The shared
        // 'halt-done' key means this confirm supersedes the firing client's interim
        // "Halting N…" toast in place (haltHerd posts it under the same key), and also
        // dedupes back-to-back halts / the echo to the firer into one row.
        toasts.info(m.halt_done({ count: ev.data.halted }), { key: "halt-done" });
        break;
      case "mergetrain:landed":
        this.confirmMergeTrainLanded(ev.data.repoPath);
        break;
      case "draftreconcile:status":
        this.applyDraftReconcile(ev.data);
        break;
    }
  }

  /** Confirm a merge train landed. A train lands a batch (no single PR number), so this
   *  is a plain repo-keyed info toast — no per-merge update offer. The local default-branch
   *  checkout stays updatable on demand via BacklogView's Fast-forward button. */
  private confirmMergeTrainLanded(repoPath: string): void {
    const repo = repoPath.split("/").pop() ?? repoPath;
    toasts.info(m.toast_mergetrain_landed({ repo }), { key: `mergetrain-landed:${repoPath}` });
  }

  /** Handle a draft-reconcile status push. On error: raise a persistent, assertive
   *  toast (keyed per session, stays until dismissed). On success (state=null):
   *  dismiss the keyed toast for that session (if one is live). */
  private applyDraftReconcile(data: {
    repoPath: string;
    sessionId: string;
    state: "promote_error" | "enforce_error" | null;
    detail: string | null;
  }) {
    const { sessionId, state, detail } = data;
    const key = `draft-reconcile:${sessionId}`;
    if (state === "promote_error" || state === "enforce_error") {
      const text =
        state === "promote_error"
          ? m.draft_reconcile_promote_error({ desig: detail ?? "" })
          : m.draft_reconcile_enforce_error({ desig: detail ?? "" });
      const id = toasts.info(text, { key, sticky: true, alert: true });
      this.draftReconcileToastIds.set(sessionId, id);
    } else {
      // state === null: success — clear the alert if one is showing
      this.clearDraftReconcileToast(sessionId);
    }
  }

  /** Dismiss a session's persistent draft-reconcile error toast, if any. Called on a
   *  success (state=null) and on archive, so an archived session never strands a
   *  persistent error toast that can no longer self-resolve. */
  private clearDraftReconcileToast(sessionId: string) {
    const id = this.draftReconcileToastIds.get(sessionId);
    if (id !== undefined) {
      toasts.close(id);
      this.draftReconcileToastIds.delete(sessionId);
    }
  }

  /** Connect the /events WS with auto-reconnect. Returns a disposer. */
  connect(makeWs: () => WebSocket = () => new WebSocket(wsUrl("/events"))): () => void {
    let ws: WebSocket | null = null;
    let stopped = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    // Report whether this window is actively in use so the server can suppress
    // push banners while it is (the live UI already shows the change). Page-context
    // focus+visibility is reliable on Android, unlike a SW's WindowClient.focused.
    const active = () =>
      typeof document !== "undefined" &&
      document.visibilityState === "visible" &&
      document.hasFocus();
    const reportPresence = () => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "presence", active: active() }));
      }
    };
    // Mirror the same focus/visibility read into reactive state for the ambient
    // tab-signal. Set DIRECTLY in each presence handler below (not only here or in
    // wake()): on a become-visible-with-dead-socket edge onVisible→wake()→open()
    // defers presence to ws.onopen, and pageshow only wakes when persisted, so
    // routing attended through reportPresence/wake alone would let it lag.
    const syncAttended = () => {
      this.attended = active();
    };
    const open = () => {
      // Drop the previous socket's handlers before replacing it so a superseded
      // socket's late onclose can't schedule a second, parallel reconnect.
      if (ws) {
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      ws = makeWs();
      ws.onopen = () => {
        this.connected = true;
        this.connectionEpoch += 1;
        reportPresence();
      };
      ws.onmessage = (e) => {
        try {
          this.apply(JSON.parse(e.data));
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        this.connected = false;
        if (!stopped && !reconnectTimer)
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            open();
          }, 1000);
      };
      ws.onerror = () => ws?.close();
    };
    // Mobile freezes a backgrounded tab and silently drops the WS; the onclose
    // backoff timer is frozen too, so a returning tab can sit on a dead socket
    // and never resume the stream. On return, reconnect at once if the socket
    // isn't live — mirrors the PTY's visibility/pageshow poke. pageshow+persisted
    // covers iOS bfcache restore, which doesn't reliably fire visibilitychange.
    const wake = () => {
      if (stopped) return;
      // Only a confirmed-OPEN socket is left alone. A tab frozen mid-handshake
      // resumes in CONNECTING with a dead connection that may never fire
      // onopen/onclose, so treat it as stale and reopen — the open() swap nulls
      // the old socket's handlers first, so the abandoned connect is harmless.
      if (ws && ws.readyState === WebSocket.OPEN) reportPresence();
      else open(); // CONNECTING/CLOSING/CLOSED/none — resume the stream now
    };
    const onVisible = () => {
      syncAttended();
      return document.visibilityState === "visible" ? wake() : reportPresence();
    };
    const onFocus = () => {
      syncAttended();
      reportPresence();
    };
    const onBlur = () => {
      syncAttended();
      reportPresence();
    };
    const onPageShow = (e: PageTransitionEvent) => {
      syncAttended();
      if (e.persisted) wake();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible);
      window.addEventListener("focus", onFocus);
      window.addEventListener("blur", onBlur);
      window.addEventListener("pageshow", onPageShow);
    }
    syncAttended(); // correct initial value before the first open()
    open();
    return () => {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible);
        window.removeEventListener("focus", onFocus);
        window.removeEventListener("blur", onBlur);
        window.removeEventListener("pageshow", onPageShow);
      }
      ws?.close();
    };
  }
}

function dropKey<T>(rec: Record<string, T>, id: string): Record<string, T> {
  const copy = { ...rec };
  delete copy[id];
  return copy;
}

export function wsUrl(path: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${path}`;
}
