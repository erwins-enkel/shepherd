<script lang="ts">
  import { m } from "$lib/paraglide/messages";

  // Instrument toggle on the setting-row control column: OFF/ON status text,
  // then a 30×16 track (40×22 on mobile) with a square knob. ON = amber knob,
  // amber-mixed track border, amber status — the handoff's toggle spec. The
  // button is the accessible switch; SettingRow's onrowclick widens the hit
  // area to the whole row.
  let {
    checked,
    disabled = false,
    label,
    onchange,
  }: {
    checked: boolean;
    disabled?: boolean;
    /** Accessible name — the row title (the visible text is only ON/OFF). */
    label: string;
    onchange: () => void;
  } = $props();
</script>

<button
  type="button"
  class="stoggle"
  role="switch"
  aria-checked={checked}
  aria-label={label}
  {disabled}
  onclick={onchange}
>
  <span class="status" class:on={checked}>
    {checked ? m.settings_usage_hold_on() : m.settings_usage_hold_off()}
  </span>
  <span class="track" class:on={checked} aria-hidden="true"><span class="knob"></span></span>
</button>

<style>
  .stoggle {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: transparent;
    border: 0;
    padding: 0;
    cursor: pointer;
    font: inherit;
  }
  .stoggle:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .stoggle:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .status {
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-faint);
  }
  .status.on {
    color: var(--color-amber);
  }
  .track {
    box-sizing: border-box;
    width: 30px;
    height: 16px;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    background: var(--color-inset);
    padding: 2px;
    display: inline-flex;
    align-items: center;
    justify-content: flex-start;
    flex-shrink: 0;
  }
  .track.on {
    border-color: color-mix(in srgb, var(--color-amber) 62%, var(--color-line));
    justify-content: flex-end;
  }
  .knob {
    width: 10px;
    height: 10px;
    background: var(--color-muted);
  }
  .track.on .knob {
    background: var(--color-amber);
  }

  @media (max-width: 768px) {
    .stoggle {
      min-height: 44px;
    }
    .status {
      font-size: var(--fs-meta);
    }
    .track {
      width: 40px;
      height: 22px;
      padding: 3px;
    }
    .knob {
      width: 14px;
      height: 14px;
    }
  }
</style>
