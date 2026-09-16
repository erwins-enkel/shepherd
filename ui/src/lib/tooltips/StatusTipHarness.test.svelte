<script lang="ts">
  // Test-only harness: drives statusTip through a real `use:` directive, so update() runs
  // inside Svelte's tracked action effect with a fresh structured params object per run.
  import { statusTip } from "./statusTip.svelte";

  let units = $state("1.2");
  export function setUnits(next: string) {
    units = next;
  }
</script>

<span
  data-testid="tip-trigger"
  use:statusTip={{
    text: {
      title: "Cache expired",
      summary: "Resuming re-reads the context.",
      sections: [{ label: "Next turn", text: `${units} units` }],
    },
    wide: true,
  }}>chip</span
>
