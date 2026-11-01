// `ctx.forge.security`: open code scanning and Dependabot alerts for plugins. Resolves the repo's
// forge per call and masks secret-shaped text. Alert text stays untrusted; the caller fences it.

import type { ForgeAlertList } from "../forge/types";
import { redactSecretText } from "../redact";
import { forgeFor, type PluginForgeDeps } from "./forge-runs";
import type { PluginForgeSecurity } from "./types";

function maskAlerts<T>(list: ForgeAlertList<T>, mask: (alert: T) => T): ForgeAlertList<T> {
  return list.status === "ok" ? { ...list, alerts: list.alerts.map(mask) } : list;
}

/** Build the `ctx.forge.security` surface for one plugin. */
export function makePluginForgeSecurity(deps: PluginForgeDeps | undefined): PluginForgeSecurity {
  return {
    listCodeScanningAlerts: async (repo) =>
      maskAlerts(
        await forgeFor(deps, repo, "listCodeScanningAlerts").listCodeScanningAlerts(),
        (a) => ({
          ...a,
          ruleDescription: redactSecretText(a.ruleDescription),
          message: redactSecretText(a.message),
        }),
      ),
    listDependabotAlerts: async (repo) =>
      maskAlerts(
        await forgeFor(deps, repo, "listDependabotAlerts").listDependabotAlerts(),
        (a) => ({
          ...a,
          summary: redactSecretText(a.summary),
        }),
      ),
    visibility: async (repo) => forgeFor(deps, repo, "repoVisibility").repoVisibility(),
  };
}
