<script lang="ts">
  import { untrack } from "svelte";
  import { m } from "#lib/paraglide/messages.js";
  import {
    putEgressMutedHosts,
    putEgressStandardDefault,
    putEgressStandardHosts,
    type EgressSettings,
  } from "#lib/api.js";
  import { toasts } from "#lib/toasts.svelte.js";
  import { checkEgressHost, checkMutedHost } from "#lib/list-entries.js";
  import { classifyEgressHost } from "#lib/egress-trust.js";
  import {
    egressMutedHostsExplanation,
    egressRiskExplanation,
    egressRiskLabel,
    egressStandardHostsExplanation,
  } from "#lib/tooltips/explanations.js";
  import type { Settings } from "#lib/types.js";
  import ListField, { type ListItemWarning } from "../repo-settings/ListField.svelte";
  import SettingRow from "./SettingRow.svelte";
  import SettingToggle from "./SettingToggle.svelte";

  // Settings › Session › Network egress: the standard allowed hosts repos opt into (repo settings ›
  // Agent › Include standard hosts), what repos on Inherit get, and the hosts the firewall still
  // blocks but never reports. Seeded once from the parent's settings payload.
  let { payload, query = "" }: { payload: Settings | null; query?: string } = $props();

  let standard = $state<string[]>([]);
  let standardDefault = $state(false);
  let muted = $state<string[]>([]);
  let busy = $state(false);

  $effect(() => {
    const p = payload;
    if (!p) return;
    untrack(() => {
      standard = p.egressStandardHosts ?? [];
      standardDefault = p.egressStandardDefault ?? false;
      muted = p.egressMutedHosts ?? [];
    });
  });

  async function save(write: () => Promise<Required<EgressSettings>>) {
    busy = true;
    try {
      const r = await write();
      standard = r.egressStandardHosts;
      standardDefault = r.egressStandardDefault;
      muted = r.egressMutedHosts;
    } catch {
      toasts.info(m.settings_egress_save_failed(), { alert: true });
    } finally {
      busy = false;
    }
  }

  const HOST_ERRORS = {
    empty: () => m.automation_egress_hosts_err_empty(),
    invalid: () => m.automation_egress_hosts_err_invalid(),
    duplicate: () => m.automation_egress_hosts_err_duplicate(),
  };
  const MUTED_ERRORS = { ...HOST_ERRORS, invalid: () => m.settings_egress_muted_err_invalid() };

  /** A risky standard host widens every repo that includes the set, so it warns like a repo's. */
  function warning(host: string): ListItemWarning | null {
    const t = classifyEgressHost(host);
    if (t.tier !== "risky") return null;
    const reason = egressRiskLabel(t.reason);
    return {
      text: m.automation_egress_hosts_warn({ reason }),
      label: m.automation_egress_hosts_risky_chip({ host, reason }),
      explanation: egressRiskExplanation(t.reason),
    };
  }
</script>

<SettingRow
  title={m.settings_egress_standard_title()}
  description={m.settings_egress_standard_hint()}
  explanation={egressStandardHostsExplanation()}
  {query}
>
  {#snippet below()}
    <ListField
      bare
      field="egressStandardHosts"
      name={m.settings_egress_standard_title()}
      items={standard}
      check={checkEgressHost}
      errors={HOST_ERRORS}
      placeholder={m.automation_egress_hosts_placeholder()}
      addLabel={m.automation_egress_hosts_add()}
      removeLabel={(host) => m.automation_egress_hosts_remove({ host })}
      empty={m.settings_egress_standard_empty()}
      warn={warning}
      addAnywayLabel={m.automation_egress_hosts_add_anyway()}
      onchange={(hosts) => void save(() => putEgressStandardHosts(hosts))}
    />
  {/snippet}
</SettingRow>

<SettingRow
  title={m.settings_egress_standard_default_title()}
  description={m.settings_egress_standard_default_hint()}
  {query}
  inlineOnMobile
>
  {#snippet control()}
    <SettingToggle
      checked={standardDefault}
      disabled={busy}
      label={m.settings_egress_standard_default_title()}
      onchange={() => void save(() => putEgressStandardDefault(!standardDefault))}
    />
  {/snippet}
</SettingRow>

<SettingRow
  title={m.settings_egress_muted_title()}
  description={m.settings_egress_muted_hint()}
  explanation={egressMutedHostsExplanation()}
  {query}
>
  {#snippet below()}
    <ListField
      bare
      field="egressMutedHosts"
      name={m.settings_egress_muted_title()}
      items={muted}
      check={checkMutedHost}
      errors={MUTED_ERRORS}
      placeholder={m.settings_egress_muted_placeholder()}
      addLabel={m.automation_egress_hosts_add()}
      removeLabel={(host) => m.settings_egress_muted_remove({ host })}
      empty={m.settings_egress_muted_empty()}
      onchange={(hosts) => void save(() => putEgressMutedHosts(hosts))}
    />
  {/snippet}
</SettingRow>
