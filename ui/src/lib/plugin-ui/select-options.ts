export interface SelectOption {
  value: string;
  label: string;
}

/** Coerce a node's `options` prop, labelling a bare value with itself. */
export function selectOptions(options: unknown): SelectOption[] {
  return (Array.isArray(options) ? (options as unknown[]) : [])
    .filter(
      (o): o is Record<string, unknown> =>
        !!o && typeof o === "object" && typeof (o as Record<string, unknown>).value === "string",
    )
    .map((o) => ({
      value: o.value as string,
      label: typeof o.label === "string" ? o.label : (o.value as string),
    }));
}
