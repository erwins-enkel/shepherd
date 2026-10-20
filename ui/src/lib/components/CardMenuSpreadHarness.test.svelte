<script lang="ts">
  // Test-only harness: spreads a replaceable actions object into CardMenu, exactly as
  // UnitRow spreads its `menuActions` $derived — which rebuilds on every session poll.
  // refresh() mimics one poll: same keys, fresh closures, new object identity.
  import CardMenu from "./CardMenu.svelte";

  let { x, y }: { x: number; y: number } = $props();

  function make() {
    return {
      onmergepr: () => {},
      onrename: () => {},
      onamend: () => {},
      onrelaunchElsewhere: () => {},
      oncleanTerminal: () => {},
      ondecommission: () => {},
    };
  }
  let actions = $state(make());
  export function refresh() {
    actions = make();
  }
</script>

<CardMenu {x} {y} resumable={false} {...actions} onclose={() => {}} />
