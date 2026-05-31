import { m } from "$lib/paraglide/messages";
import { getLocale, locales, setLocale, type Locale } from "$lib/paraglide/runtime";

export { getLocale, locales, setLocale, type Locale };

/** Endonym shown in the switcher menu (always in its own language). */
export function localeName(l: Locale): string {
  return l === "de" ? m.lang_german() : m.lang_english();
}

/** Short code shown on the collapsed control, e.g. "EN" / "DE". */
export function localeCode(l: Locale): string {
  return l.toUpperCase();
}
