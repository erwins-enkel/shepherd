<script lang="ts">
  import type { SessionStatus } from "$lib/types";
  import { STATUS_COLOR } from "$lib/format";
  let { status }: { status: SessionStatus } = $props();
</script>

<span class="pip" class:pulse={status === "running"} style="--c:{STATUS_COLOR[status]}"></span>

<style>
  .pip {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--c);
    display: inline-block;
    box-shadow: 0 0 0 0 var(--c);
  }
  .pulse {
    animation: pip-pulse 1.5s ease-out infinite;
  }
</style>
