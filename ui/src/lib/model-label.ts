import { m } from "$lib/paraglide/messages";

/**
 * Friendly display label for a model alias shown in pickers and session cards.
 *
 * The bracketed 1M-context aliases ("opus[1m]" / "sonnet[1m]") are valid `--model`
 * values but must never surface to users as the raw token — they render as a
 * localized "Opus (1M context)" etc. Every other alias is a plain identifier and
 * renders as-is, matching how the pickers already showed the bare aliases.
 */
export function modelLabel(alias: string): string {
  switch (alias) {
    case "opus[1m]":
      return m.model_label_opus_1m();
    case "sonnet[1m]":
      return m.model_label_sonnet_1m();
    default:
      return alias;
  }
}
