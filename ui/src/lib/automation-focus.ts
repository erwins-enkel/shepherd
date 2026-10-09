// A one-shot request to focus a field of the Automation tab once it mounts — the epic detail's
// "Allow N slots" opens the tab at the agent-slot cap (#2939) without writing it. It lapses after
// a moment, so a request nobody took never focuses a later, unrelated visit.

type AutomationField = "max-auto";

const TTL_MS = 2_000;

let pending: { field: AutomationField; at: number } | null = null;

export const automationFocus = {
  request(field: AutomationField): void {
    pending = { field, at: Date.now() };
  },
  /** True once, for a request still fresh; consumes it. */
  take(field: AutomationField): boolean {
    const p = pending;
    if (p?.field !== field) return false;
    pending = null;
    return Date.now() - p.at <= TTL_MS;
  },
};
