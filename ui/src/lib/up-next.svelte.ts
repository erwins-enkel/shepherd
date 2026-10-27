import { SvelteSet } from "svelte/reactivity";
import type { UpNextSnapshot } from "./types";
import { getUpNext, type UpNextRead } from "./api";

/** One cache per page/auth lifetime. Consumers register demand while the lens is mounted. */
export class UpNextStore {
  snapshot = $state<UpNextSnapshot | null>(null);
  loaded = $state(false);
  loadError = $state(false);
  private etag: string | null = null;
  private cached = false;
  private consumers = new SvelteSet<symbol>();
  private dirty = false;
  private openRead = false;
  private revision = 0;
  private generation = 0;
  private task: Promise<void> | null = null;

  constructor(private read = getUpNext) {}

  open(): () => void {
    const consumer = Symbol();
    this.consumers.add(consumer);
    this.openRead = true;
    this.changed();
    return () => {
      this.consumers.delete(consumer);
    };
  }

  /** Passive demand: keep the cached snapshot current with cache-only (`peek`) reads — never a
   *  recompute — for surfaces outside the lens, like the lens tab's ready-PR badge. */
  watch(): () => void {
    const consumer = Symbol();
    this.consumers.add(consumer);
    this.changed();
    return () => {
      this.consumers.delete(consumer);
    };
  }

  changed() {
    this.revision++;
    this.dirty = true;
    this.startRead();
  }

  reconnected() {
    this.changed();
  }

  /** Re-read the cached snapshot now — never a recompute — and resolve once it has landed. */
  async reload(): Promise<void> {
    this.changed();
    await this.task;
  }

  private startRead() {
    if (this.task || !this.consumers.size) return;
    const generation = this.generation;
    this.task = this.revalidate(generation).finally(() => {
      if (generation === this.generation) this.task = null;
    });
  }

  private async revalidate(generation: number) {
    while (this.dirty && this.consumers.size && generation === this.generation) {
      const revision = this.revision;
      const peek = !this.openRead;
      this.openRead = false;
      this.dirty = false;
      try {
        const result = await this.read({ peek, etag: this.cached ? this.etag : null });
        if (generation !== this.generation || revision !== this.revision) continue;
        this.applyRead(result);
      } catch {
        if (generation !== this.generation || revision !== this.revision) continue;
        this.loadError = true;
        this.loaded = true;
        this.dirty = true;
        // Retry on the next signal/open/reconnect, not in a tight failure loop.
        return;
      }
    }
  }

  private applyRead(result: UpNextRead) {
    if (result.modified) {
      this.snapshot = result.snapshot;
      this.etag = result.etag;
      this.cached = true;
    }
    this.loadError = false;
    this.loaded = true;
  }

  /** Older servers may still push data. Its validator cannot describe that payload. */
  apply(d: { snapshot: UpNextSnapshot }) {
    this.revision++;
    this.snapshot = d.snapshot;
    this.etag = null;
    this.cached = true;
    this.dirty = false;
    this.loaded = true;
    this.loadError = false;
  }

  reset() {
    this.generation++;
    this.revision++;
    this.task = null;
    this.consumers.clear();
    this.snapshot = null;
    this.etag = null;
    this.cached = false;
    this.loaded = false;
    this.loadError = false;
    this.dirty = false;
    this.openRead = false;
  }
}
export const upNext = new UpNextStore();
