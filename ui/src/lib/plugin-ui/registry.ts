import type { Component } from "svelte";
import PuiStack from "./PuiStack.svelte";
import PuiText from "./PuiText.svelte";
import PuiBadge from "./PuiBadge.svelte";
import PuiMeter from "./PuiMeter.svelte";
import PuiTable from "./PuiTable.svelte";
import PuiKeyValue from "./PuiKeyValue.svelte";
import PuiCallout from "./PuiCallout.svelte";
import PuiGauge from "./PuiGauge.svelte";
import PuiSparkline from "./PuiSparkline.svelte";

/** Whitelist of plugin UI node types. Unknown types fall through to UnknownNodeTile. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PLUGIN_UI_REGISTRY: Record<string, Component<any>> = {
  stack: PuiStack,
  text: PuiText,
  badge: PuiBadge,
  meter: PuiMeter,
  table: PuiTable,
  "key-value": PuiKeyValue,
  callout: PuiCallout,
  gauge: PuiGauge,
  sparkline: PuiSparkline,
};
