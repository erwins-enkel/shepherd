<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { repoConfig } from "#lib/reviews.svelte.js";
  import type { RepoConfig } from "#lib/types.js";
  import RepoSettingRow from "./RepoSettingRow.svelte";
  import "../automation-settings/automation-fields.css";

  // Display (#3443): what a Preview chip does, and where the repo sits in the Backlog's repo list.
  // Pin and hide are the very fields the list's own Pin / Hide write (same overlay), so both
  // places always agree.
  let { repoPath }: { repoPath: string } = $props();

  // Until the config loaded, "off" is only a guess — a flip from it could pin a pinned repo again.
  $effect(() => void repoConfig.ensure(repoPath));
  const loaded = $derived(repoConfig.isConfigLoaded(repoPath));
  const pinned = $derived(repoConfig.isPinned(repoPath, false));
  const hidden = $derived(repoConfig.isHidden(repoPath, false));
</script>

<RepoSettingRow
  field="previewOpenMode"
  name={m.automation_preview_open_mode_label()}
  desc={m.automation_preview_open_mode_hint()}
>
  {#snippet control()}
    <select
      class="afield-num afield-select"
      aria-label={m.automation_preview_open_mode_label()}
      value={repoConfig.previewOpenModeFor(repoPath)}
      onchange={(e) =>
        repoConfig.setPreviewOpenMode(
          repoPath,
          (e.currentTarget as HTMLSelectElement).value as RepoConfig["previewOpenMode"],
        )}
    >
      <option value="ask">{m.preview_open_mode_ask()}</option>
      <option value="inline">{m.preview_open_mode_inline()}</option>
      <option value="tab">{m.preview_open_mode_tab()}</option>
    </select>
  {/snippet}
</RepoSettingRow>
<RepoSettingRow
  field="pinned"
  glyph="⌖"
  name={m.reposettings_pin_name()}
  desc={m.reposettings_pin_desc()}
  checked={pinned}
  pending={!loaded}
  ontoggle={() => repoConfig.togglePinned(repoPath, pinned)}
/>
<RepoSettingRow
  field="hidden"
  glyph="◌"
  name={m.reposettings_hide_name()}
  desc={m.reposettings_hide_desc()}
  checked={hidden}
  pending={!loaded}
  ontoggle={() => repoConfig.toggleHidden(repoPath, hidden)}
/>
