import type { RepoSettingsSection } from "#lib/components/repo-settings/sections.js";

// A one-shot request for the Backlog's Settings tab once it mounts: the section to open at and,
// for a field, the field to focus — the epic detail's "Allow N slots" opens the tab at the
// agent-slot cap (#2939) without writing it. It lapses after a moment, so a request nobody took
// never steers a later, unrelated visit.

type AutomationField = "max-auto";

/** The section each field lives in. */
const SECTION_OF: Record<AutomationField, RepoSettingsSection> = { "max-auto": "start" };

const TTL_MS = 2_000;

let pending: { section: RepoSettingsSection; field: AutomationField | null; at: number } | null =
  null;

const fresh = (p: { at: number }) => Date.now() - p.at <= TTL_MS;

export const automationFocus = {
  /** Open the tab at `field`'s section and focus it. */
  request(field: AutomationField): void {
    pending = { section: SECTION_OF[field], field, at: Date.now() };
  },
  /** Open the tab at `section`, focusing nothing. */
  openAt(section: RepoSettingsSection): void {
    pending = { section, field: null, at: Date.now() };
  },
  /** The section a still-fresh request opens the tab at; leaves the request in place. */
  section(): RepoSettingsSection | undefined {
    return pending && fresh(pending) ? pending.section : undefined;
  },
  /** True once, for a request still fresh; consumes it. */
  take(field: AutomationField): boolean {
    const p = pending;
    if (p?.field !== field) return false;
    pending = null;
    return fresh(p);
  },
};
