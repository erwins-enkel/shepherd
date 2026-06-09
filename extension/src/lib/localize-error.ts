import { m } from "./paraglide/messages";
import type { TransportErrorKind } from "./types";

/**
 * Map a transport failure (`TransportErrorKind`, or the popup-only `"capture"`
 * pseudo-kind) to a localized, user-facing message. Shared by the popup and the
 * options page so both surface failures through ONE classification path — no
 * duplicated switch that can drift. `unreachable` interpolates `baseUrl`;
 * `invalid`/`unknown` interpolate the server's `message` detail.
 */
export function localizeError(
  kind: TransportErrorKind | "capture",
  message: string,
  baseUrl: string,
): string {
  switch (kind) {
    case "origin":
      return m.err_origin();
    case "auth":
      return m.err_auth();
    case "invalid":
      return m.err_invalid({ message });
    case "too_large":
      return m.err_too_large();
    case "unsupported":
      return m.err_unsupported();
    case "unreachable":
      return m.err_unreachable({ baseUrl });
    case "capture":
      return m.popup_cant_capture();
    default:
      return m.err_unknown({ message });
  }
}
