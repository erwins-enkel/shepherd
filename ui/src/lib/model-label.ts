import { m } from "$lib/paraglide/messages";

/**
 * Friendly display label for a model alias — the RECORD label.
 *
 * Use this wherever the value being rendered was STORED AT SPAWN/SUBMIT TIME: a
 * session card, the status bar, the plan panel, the review-in-flight banner, the
 * viewport, experiment groups. For a run that already happened, the only honest
 * label is what that run was configured with.
 *
 * This is why the floating aliases ("opus", "sonnet", …) deliberately render as
 * the bare token here and NOT as "Opus (latest)": `opus` resolves to whatever the
 * installed CLI calls the newest Opus, so labelling an archived session "latest"
 * would claim it ran today's model when it ran whichever was current back then.
 * For present-tense surfaces — a run that has not happened yet — use
 * {@link configuredModelLabel} instead.
 *
 * The bracketed 1M-context aliases ("opus[1m]" / "sonnet[1m]") are valid `--model`
 * values but must never surface to users as the raw token — they render as a
 * localized "Opus (1M context)" etc. The pinned full model names
 * ("claude-opus-5") likewise render as "Opus 5" rather than the raw id; they are
 * safe on both surfaces because a pinned name means the same model forever.
 * Every other alias is a plain identifier and renders as-is.
 */
export function modelLabel(alias: string): string {
  switch (alias) {
    case "opus[1m]":
      return m.model_label_opus_1m();
    case "sonnet[1m]":
      return m.model_label_sonnet_1m();
    case "claude-opus-5":
      return m.model_label_opus_5();
    case "claude-opus-5[1m]":
      return m.model_label_opus_5_1m();
    default:
      return alias;
  }
}

/**
 * Display label for a model the operator is ABOUT TO USE — the CONFIGURED label.
 *
 * Use this wherever the rendered value describes a run that has NOT HAPPENED yet:
 * picker option rows, the New Task engine summary, the per-role "effective
 * environment" readout, the recommend dialog header. There "latest" is a true,
 * present-tense statement, and spelling it out is what distinguishes the floating
 * `opus` row from the pinned `claude-opus-5` row — otherwise the two sit side by
 * side with identical cost and fit markers and nothing tells them apart.
 *
 * Everything it does not override delegates to {@link modelLabel}, so the two
 * vocabularies differ ONLY where tense actually changes the meaning.
 *
 * Do not collapse this into `modelLabel` to "fix" the inconsistency: that would
 * relabel already-run sessions (see the note there). `model-guidance.test.ts`
 * pins both sides of the split.
 */
export function configuredModelLabel(alias: string): string {
  switch (alias) {
    case "opus":
      return m.model_configured_opus_latest();
    case "opus[1m]":
      return m.model_configured_opus_1m_latest();
    default:
      return modelLabel(alias);
  }
}
