<script lang="ts">
  import type { IncomingMirror, RemoteInstance } from "#lib/types.js";
  import { machineStatusLabel } from "#lib/machines.js";
  import { lastKnownLabel } from "#lib/remote-sessions.js";
  import { m } from "#lib/paraglide/messages.js";

  // A Shepherd that mirrors this one right now (#3056): it sees this Shepherd's sessions. Whether
  // this one sees its sessions too is the server's call, made from its own check of the claimed ID;
  // the claimed name is shown, never trusted. A one-way link names the cause and, when nothing here
  // carries that ID, offers to connect it.
  let {
    mirror,
    machines,
    now,
    onconnect,
  }: {
    mirror: IncomingMirror;
    /** The machines connected here, to find the one with the claimed ID. */
    machines: RemoteInstance[];
    /** When the parent last loaded the list. */
    now: number;
    /** Open the connect form, starting from this name. */
    onconnect: (name: string) => void;
  } = $props();

  const here = $derived(
    mirror.instanceId === null
      ? undefined
      : machines.find((x) => x.instanceId === mirror.instanceId),
  );
  const claimed = $derived(mirror.name ?? mirror.tokenName);
  // Both directions: the name it has here, which this Shepherd checked itself.
  const name = $derived(
    (mirror.direction === "both" ? here?.name : null) ??
      claimed ??
      m.settings_machines_incoming_unnamed(),
  );
  const direction = $derived(
    {
      both: m.settings_machines_direction_both(),
      one: m.settings_machines_direction_one(),
      unknown: m.settings_machines_direction_unknown(),
    }[mirror.direction],
  );
  const token = $derived(
    mirror.tokenName === null
      ? m.settings_machines_incoming_token_unnamed()
      : m.settings_machines_incoming_token({ name: mirror.tokenName }),
  );
</script>

<li class="mch-row" data-incoming={mirror.instanceId ?? ""}>
  <div class="mch-main">
    <span class="mch-title">
      <span class="mch-name">{name}</span>
      <span
        class="mch-badge"
        class:mch-warn={mirror.direction === "one"}
        data-direction={mirror.direction}>{direction}</span
      >
    </span>
    <span class="mch-meta"
      >{m.settings_machines_incoming_since({ at: lastKnownLabel(mirror.since, now) })} · {token}</span
    >
    {#if mirror.direction === "unknown"}
      <p class="mch-hint">{m.settings_machines_incoming_unknown_hint()}</p>
    {:else if mirror.direction === "one" && here}
      <p class="mch-hint">
        {m.settings_machines_incoming_offline_hint({ status: machineStatusLabel(here.status) })}
      </p>
    {:else if mirror.direction === "one"}
      <p class="mch-hint">{m.settings_machines_incoming_one_hint({ name })}</p>
    {/if}
  </div>
  {#if mirror.direction === "one" && !here}
    <div class="mch-actions">
      <button type="button" class="set-gbtn" onclick={() => onconnect(claimed ?? "")}
        >{m.settings_machines_connect_here({ name })}</button
      >
    </div>
  {/if}
</li>
