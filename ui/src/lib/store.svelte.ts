import type {
  Session,
  WsEvent,
  UsageLimits,
  UpdateStatus,
  HerdrUpdateStatus,
  GitState,
} from "./types";
import type { BlockState } from "./triage";
import { projectIcons } from "./projectIcons.svelte";
import { reviews } from "./reviews.svelte";

export class HerdStore {
  sessions = $state<Session[]>([]);
  blocks = $state<Record<string, BlockState>>({});
  connected = $state(false);
  usageLimits = $state<UsageLimits | null>(null);
  update = $state<UpdateStatus | null>(null);
  herdrUpdate = $state<HerdrUpdateStatus | null>(null);
  herdrUpdateLog = $state<string[]>([]);
  git = $state<Record<string, GitState>>({});
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
      case "session:archived":
        this.sessions = this.sessions.filter((s) => s.id !== ev.data.id);
        this.blocks = dropKey(this.blocks, ev.data.id);
        this.git = dropKey(this.git, ev.data.id);
        reviews.drop(ev.data.id);
        break;
      case "session:git":
        this.git = { ...this.git, [ev.data.id]: ev.data.git };
        break;
      case "session:block": {
        if (!ev.data.block) {
          this.blocks = dropKey(this.blocks, ev.data.id);
          break;
        }
        const prev = this.blocks[ev.data.id];
        this.blocks = {
          ...this.blocks,
          [ev.data.id]: { reason: ev.data.block, since: prev?.since ?? Date.now() },
        };
        break;
      }
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
      case "project-icons:update":
        projectIcons.apply(ev.data);
        break;
      case "session:review":
        reviews.apply(ev.data);
        break;
      case "session:reviewing":
        reviews.setReviewing(ev.data.id, ev.data.reviewing);
        break;
    }
  }

  /** Connect the /events WS with auto-reconnect. Returns a disposer. */
  connect(makeWs: () => WebSocket = () => new WebSocket(wsUrl("/events"))): () => void {
    let ws: WebSocket | null = null;
    let stopped = false;
    const open = () => {
      ws = makeWs();
      ws.onopen = () => (this.connected = true);
      ws.onmessage = (e) => {
        try {
          this.apply(JSON.parse(e.data));
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        this.connected = false;
        if (!stopped) setTimeout(open, 1000);
      };
      ws.onerror = () => ws?.close();
    };
    open();
    return () => {
      stopped = true;
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
