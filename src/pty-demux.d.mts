// Type declarations for the plain-JS pty-demux helper (imported by tests under
// the root strict tsconfig, which type-checks all .ts and resolves this .mjs).
export interface DemuxHandlers {
  /** Forwarded terminal input (control frames stripped). */
  onInput: (data: string) => void;
  /** Forwarded resize frames, de-duplicated to genuine size changes. */
  onResize: (cols: number, rows: number) => void;
}

export interface Demux {
  /** Feed a raw stdin chunk; buffers partial frames across calls. */
  feed(chunk: string): void;
}

export function createDemux(handlers: DemuxHandlers): Demux;
