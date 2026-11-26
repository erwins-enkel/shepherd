import { m } from "#lib/paraglide/messages.js";

export function codexSpeedReason(reason: string | undefined): string {
  switch (reason) {
    case "version":
      return m.codex_speed_unavailable_version();
    case "login":
      return m.codex_speed_unavailable_login();
    case "disabled":
      return m.codex_speed_unavailable_policy();
    case "model":
      return m.codex_speed_unavailable_model();
    default:
      return m.codex_speed_unavailable_unknown();
  }
}
