// Pure mapping from a verify-key failure `reason` (+ optional `detail`) to a localized
// message. Kept framework-free (the localized strings are injected) so it's unit-testable
// without the Paraglide runtime — Settings.svelte passes its `m.*` resolvers.
//
// `detail` is server DATA (a verbatim claude auth-error string), surfaced as-is — NOT
// translated — appended only to the not-authenticated case where it's present.

export type VerifyMessages = {
  notAuthenticated: () => string;
  timeout: () => string;
  generic: () => string;
};

export function verifyFailureMessage(
  reason: string | undefined,
  detail: string | undefined,
  msgs: VerifyMessages,
): string {
  switch (reason) {
    case "not-authenticated": {
      const base = msgs.notAuthenticated();
      return detail ? `${base} (${detail})` : base;
    }
    case "timeout":
      return msgs.timeout();
    default:
      return msgs.generic();
  }
}
