import type {
  Session,
  WsEvent,
  UsageLimits,
  UpdateStatus,
  HerdrUpdateStatus,
  GitState,
  SessionActivity,
  BacklogPayload,
  BlockReason,
  DrainStatus,
  AutoMergeStatus,
  BuildQueue,
} from "./types";
import type { BlockState } from "./triage";
import { projectIcons } from "./projectIcons.svelte";
import { reviews, planGates } from "./reviews.svelte";
import { learnings } from "./learnings.svelte";
import { toasts } from "./toasts.svelte";
import { m } from "$lib/paraglide/messages";
import { offerUpdateMain } from "./pull-offer";

export class HerdStore {
  sessions = $state<Session[]>([]);
  blocks = $state<Record<string, BlockState>>({});
  connected = $state(false);
  usageLimits = $state<UsageLimits | null>(null);
  update = $state<UpdateStatus | null>(null);
  herdrUpdate = $state<HerdrUpdateStatus | null>(null);
  herdrUpdateLog = $state<string[]>([]);
  herdrUpdateDone = $state<{
    ok: boolean;
    from: string | null;
    to: string | null;
    error?: string;
  } | null>(null);
  git = $state<Record<string, GitState>>({});
  /** Live per-session activity signal (heartbeat + current tool), pushed by the server's `session:activity` event. */
  activity = $state<Record<string, SessionActivity>>({});
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
  /** true once the user has confirmed an update; cleared by the reload it triggers */
  updating = $state(false);
  /** SHA we booted on; a different `current` after an update means a fresh build is live */
  private runningVersion: string | null = null;

  setAll(list: Session[]) {
    this.sessions = list;
  }
  setGit(map: Record<string, GitState>) {
    this.git = map;
  }
  setActivity(map: Record<string, SessionActivity>) {
    this.activity = map;
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

  /** Patch a session's name + branch, then surface the rename (esp. the async
   *  namer's auto-rename, which lands while the agent is already working) so the
   *  row changing under the user is explained. Toasts only when the visible name
   *  actually changed: the contingency path (syncWorktreeBranch) re-emits with an
   *  unchanged name when only the branch moved, which would otherwise read as a
   *  "Renamed to <same name>" non-event. Extracted from apply() to keep that
   *  dispatch switch under the complexity gate. */
  private applyRenamed(id: string, name: string, branch: string | null) {
    const prevName = this.byId(id)?.name;
    this.sessions = this.sessions.map((s) => (s.id === id ? { ...s, name, branch } : s));
    if (prevName !== undefined && prevName !== name) toasts.info(m.toast_renamed({ name }));
  }

  apply(ev: WsEvent) {
    switch (ev.event) {
      case "session:new":
        if (!this.byId(ev.data.id)) this.sessions = [...this.sessions, ev.data];
        break;
      case "session:status":
        this.sessions = this.sessions.map((s) =>
          s.id === ev.data.id ? { ...s, status: ev.data.status } : s,
        );
        break;
      case "session:renamed":
        this.applyRenamed(ev.data.id, ev.data.name, ev.data.branch);
        break;
      case "session:ready":
        this.sessions = this.sessions.map((s) =>
          s.id === ev.data.id ? { ...s, readyToMerge: ev.data.ready } : s,
        );
        break;
      case "session:merging":
        this.sessions = this.sessions.map((s) =>
          s.id === ev.data.id
            ? { ...s, mergingSince: ev.data.since, mergingTrainId: ev.data.trainId }
            : s,
        );
        break;
      case "session:autopilot":
        this.sessions = this.sessions.map((s) =>
          s.id === ev.data.id
            ? {
                ...s,
                autopilotPaused: ev.data.paused,
                autopilotComplete: ev.data.complete,
                autopilotQuestion: ev.data.question,
                autopilotEnabled: ev.data.enabled,
              }
            : s,
        );
        break;
      case "session:automerge":
        this.sessions = this.sessions.map((s) =>
          s.id === ev.data.id ? { ...s, autoMergeEnabled: ev.data.enabled } : s,
        );
        break;
      case "session:archived":
        this.sessions = this.sessions.filter((s) => s.id !== ev.data.id);
        this.blocks = dropKey(this.blocks, ev.data.id);
        this.git = dropKey(this.git, ev.data.id);
        this.activity = dropKey(this.activity, ev.data.id);
        reviews.drop(ev.data.id);
        planGates.drop(ev.data.id);
        break;
      case "session:git":
        this.git = { ...this.git, [ev.data.id]: ev.data.git };
        break;
      case "session:activity":
        this.activity = { ...this.activity, [ev.data.id]: ev.data.activity };
        break;
      case "session:block":
        this.setBlock(ev.data.id, ev.data.block);
        break;
      case "session:review":
        reviews.apply(ev.data);
        break;
      case "session:reviewing":
        reviews.setReviewing(ev.data.id, ev.data.reviewing);
        break;
      case "session:critic-activity":
        reviews.setActivity(ev.data.id, ev.data.summary);
        break;
      case "session:plangate":
        // Emitted two ways: a fresh verdict carries `gate`; a phase flip carries `planPhase`.
        if (ev.data.gate) planGates.apply(ev.data.id, ev.data.gate);
        if (ev.data.planPhase)
          this.sessions = this.sessions.map((s) =>
            s.id === ev.data.id ? { ...s, planPhase: ev.data.planPhase! } : s,
          );
        break;
      case "session:plangate-reviewing":
        planGates.applyReviewing(ev.data.id, ev.data.reviewing);
        break;
      default:
        // App-global (non-per-session-row) events are handled out of line to keep
        // this dispatch switch under the complexity gate.
        this.applyGlobalEvent(ev);
        break;
    }
  }

  /** Handle the app-global (non per-session-row) WS events: usage limits, the
   *  self/herdr update channels, project icons, learnings, backlog + drain.
   *  Split out of apply() so its dispatch switch stays under the complexity gate. */
  private applyGlobalEvent(ev: WsEvent) {
    switch (ev.event) {
      case "usage:limits":
        this.usageLimits = ev.data;
        break;
      case "update:status":
        this.setUpdate(ev.data);
        break;
      case "herdr-update:status":
        this.herdrUpdate = ev.data;
        break;
      case "herdr-update:log":
        this.herdrUpdateLog = [...this.herdrUpdateLog, ev.data.line].slice(-200);
        break;
      case "herdr-update:done":
        this.herdrUpdateDone = ev.data as {
          ok: boolean;
          from: string | null;
          to: string | null;
          error?: string;
        };
        break;
      case "project-icons:update":
        projectIcons.apply(ev.data);
        break;
      case "learnings:update":
        learnings.apply(ev.data);
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
        offerUpdateMain(ev.data.repoPath);
        break;
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
    const onVisible = () => (document.visibilityState === "visible" ? wake() : reportPresence());
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) wake();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible);
      window.addEventListener("focus", reportPresence);
      window.addEventListener("blur", reportPresence);
      window.addEventListener("pageshow", onPageShow);
    }
    open();
    return () => {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible);
        window.removeEventListener("focus", reportPresence);
        window.removeEventListener("blur", reportPresence);
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
