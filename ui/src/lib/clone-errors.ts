import { m } from "#lib/paraglide/messages.js";

/** A failed clone's error code in words — the full code (`clonerepo_failed_auth`) or its suffix
 *  (`auth`). The Clone dialog shows it, and so does New Task when the machine a task goes to could
 *  not clone the project. An unknown code reads as the generic failure. */
export function cloneFailureText(code: string): string {
  switch (code.replace(/^clonerepo_failed_/, "")) {
    case "auth":
      return m.clonerepo_failed_auth();
    case "exists":
      return m.clonerepo_failed_exists();
    case "url":
      return m.clonerepo_failed_url();
    case "outside":
      return m.clonerepo_failed_outside();
    case "timeout":
      return m.clonerepo_failed_timeout();
    default:
      return m.clonerepo_failed_generic();
  }
}
