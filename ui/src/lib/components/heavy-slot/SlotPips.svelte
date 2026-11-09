<script lang="ts">
  import type { SlotCell } from "./heavy-slot";

  // One pip per slot: amber filled while held, a green ring while free, a struck red ring while
  // the brake blocks it. Each kind has its own shape, so it reads without color too.
  let { kinds }: { kinds: SlotCell["kind"][] } = $props();
</script>

<span class="pips" aria-hidden="true">
  {#each kinds as kind, i (i)}<span class="pip pip-{kind}"></span>{/each}
</span>

<style>
  .pips {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    flex: none;
  }
  .pip {
    position: relative;
    box-sizing: border-box;
    width: 9px;
    height: 9px;
    border-radius: 50%;
  }
  .pip-held {
    background: var(--color-amber);
  }
  .pip-free {
    border: 1.5px solid var(--color-green);
  }
  .pip-blocked {
    border: 1.5px solid var(--color-red);
  }
  .pip-blocked::after {
    content: "";
    position: absolute;
    top: -1px;
    bottom: -1px;
    left: 50%;
    width: 1.5px;
    margin-left: -0.75px;
    background: var(--color-red);
    transform: rotate(45deg);
  }
</style>
