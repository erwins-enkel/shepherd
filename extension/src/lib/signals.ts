/** One captured console line (error/warn + uncaught errors/rejections). */
export interface ConsoleEntry {
  level: "error" | "warn";
  text: string;
  /** ISO-8601. */
  ts: string;
}

/** One captured failed network request. */
export interface NetworkEntry {
  method: string;
  url: string;
  /** HTTP status (≥400), or "error" (fetch/XHR network error), or "load-error" (resource). */
  status: number | "error" | "load-error";
  ts: string;
}

/** One summarized axe-core violation. */
export interface A11yFinding {
  id: string;
  impact: "minor" | "moderate" | "serious" | "critical" | "unknown";
  help: string;
  nodeCount: number;
  /** ≤3 sample CSS selectors. */
  sampleSelectors: string[];
}

/**
 * Signals gathered for one capture. An array that is present-but-empty means
 * "this signal ran and found nothing"; an absent field means "not gathered".
 */
export interface CapturedSignals {
  console?: ConsoleEntry[];
  network?: NetworkEntry[];
  a11y?: A11yFinding[];
}

/** Which signals to gather/attach for a capture. */
export interface SignalToggles {
  screenshot: boolean;
  console: boolean;
  network: boolean;
  a11y: boolean;
}

/** A signal gathered at capture time that can fail independently of the capture. */
export type GatherSignal = "console" | "network" | "a11y";
