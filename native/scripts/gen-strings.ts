#!/usr/bin/env bun
/**
 * Mirrors a fixed subset of the web message catalogs into the macOS app's
 * String Catalog.
 *
 *   bun native/scripts/gen-strings.ts            # writes Localizable.xcstrings
 *   bun native/scripts/gen-strings.ts --check    # fails if the file is stale
 *
 * Paraglide uses {name} placeholders; .xcstrings uses positional %1$@. Names are
 * numbered by first appearance in the EN string and the SAME numbering is applied
 * to DE, so a translator may reorder placeholders freely.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const EN = join(ROOT, "ui", "messages", "en.json");
const DE = join(ROOT, "ui", "messages", "de.json");
const OUT = join(ROOT, "native", "Apps", "ShepherdMac", "Resources", "Localizable.xcstrings");

/** Every catalog key the macOS app is allowed to use. Keep alphabetical. */
export const KEYS: readonly string[] = [
  "agent_provider_claude",
  "agent_provider_codex",
  "common_cancel",
  "common_close",
  "common_loading",
  "common_retry",
  "common_save",
  "effort_default",
  "effort_label_high",
  "effort_label_low",
  "effort_label_max",
  "effort_label_medium",
  "effort_label_ultra",
  "effort_label_xhigh",
  "login_busy",
  "login_error",
  "login_password_label",
  "login_password_placeholder",
  "login_submit",
  "login_subtitle",
  "native_archive_confirm_action",
  "native_archive_confirm_body",
  "native_archive_confirm_title",
  "native_archive_failed",
  "native_banner_client_too_old",
  "native_banner_mismatch",
  "native_banner_needs_login",
  "native_banner_offline",
  "native_detail_no_selection",
  "native_detail_placeholder_body",
  "native_detail_placeholder_title",
  "native_detail_status_label",
  "native_error_first_run",
  "native_error_forbidden",
  "native_error_keychain",
  "native_error_mismatch",
  "native_error_not_found",
  "native_error_offline",
  "native_firstrun_body",
  "native_firstrun_choose",
  "native_firstrun_confirm",
  "native_firstrun_failed",
  "native_firstrun_title",
  "native_interrupt_failed",
  "native_login_sheet_title",
  "native_newsession_held",
  "native_newsession_provider_label",
  "native_sidebar_empty",
  "native_sidebar_title",
  "native_signout_failed",
  "native_toolbar_add_server",
  "native_toolbar_archive",
  "native_toolbar_interrupt",
  "native_toolbar_new_session",
  "native_toolbar_servers",
  "native_toolbar_sign_out",
  "native_url_error_empty",
  "native_url_error_insecure",
  "native_url_error_malformed",
  "native_welcome_connect",
  "native_welcome_local_body",
  "native_welcome_local_detecting",
  "native_welcome_local_found",
  "native_welcome_local_missing",
  "native_welcome_local_recheck",
  "native_welcome_local_title",
  "native_welcome_remote_body",
  "native_welcome_remote_name_label",
  "native_welcome_remote_name_placeholder",
  "native_welcome_remote_title",
  "native_welcome_remote_url_label",
  "native_welcome_remote_url_placeholder",
  "native_welcome_saved_connect",
  "native_welcome_saved_remove",
  "native_welcome_saved_title",
  "native_welcome_subtitle",
  "native_welcome_title",
  "newtask_branch_label",
  "newtask_branch_placeholder",
  "newtask_create_failed",
  "newtask_effort_label",
  "newtask_model_default",
  "newtask_model_label",
  "newtask_prompt_label",
  "newtask_prompt_placeholder",
  "newtask_repo_label",
  "newtask_spawning",
  "newtask_submit",
  "newtask_title",
  "status_archived",
  "status_blocked",
  "status_done",
  "status_idle",
  "status_working",
];

type Catalog = Record<string, string>;

function load(path: string): Catalog {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const out: Catalog = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
  return out;
}

/**
 * {name} -> %N$@, numbered by first appearance in `order`.
 *
 * `%` is only escaped to `%%` when the string carries at least one placeholder
 * (`order.size > 0`): those strings go through `String(format:)` at runtime
 * (`L.t(key, args...)`), where a bare `%` would be misread as a conversion.
 * A string with no placeholders is read via `L.t(key)`, which returns
 * `String(localized:)` verbatim with no format pass — escaping `%` there
 * would print a literal `%%` in the UI.
 */
export function convert(value: string, order: Map<string, number>): string {
  const escaped = order.size === 0 ? value : value.replace(/%/g, "%%");
  return escaped.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const index = order.get(name);
    if (index === undefined) throw new Error(`unknown placeholder {${name}}`);
    return `%${index}$@`;
  });
}

export function placeholderOrder(en: string): Map<string, number> {
  const order = new Map<string, number>();
  for (const m of en.matchAll(/\{(\w+)\}/g)) {
    const name = m[1]!;
    if (!order.has(name)) order.set(name, order.size + 1);
  }
  return order;
}

function build(): string {
  const en = load(EN);
  const de = load(DE);

  const missing: string[] = [];
  for (const key of KEYS) {
    if (en[key] === undefined) missing.push(`en.json: ${key}`);
    if (de[key] === undefined) missing.push(`de.json: ${key}`);
  }
  if (missing.length > 0) {
    throw new Error(`missing catalog keys:\n  ${missing.join("\n  ")}`);
  }

  const strings: Record<string, unknown> = {};
  for (const key of [...KEYS].sort()) {
    const order = placeholderOrder(en[key]!);
    const comment =
      order.size === 0 ? undefined : [...order].map(([name, i]) => `%${i}$@ = ${name}`).join(", ");
    strings[key] = {
      ...(comment ? { comment } : {}),
      extractionState: "manual",
      localizations: {
        de: { stringUnit: { state: "translated", value: convert(de[key]!, order) } },
        en: { stringUnit: { state: "translated", value: convert(en[key]!, order) } },
      },
    };
  }

  return `${JSON.stringify({ sourceLanguage: "en", strings, version: "1.0" }, null, 2)}\n`;
}

// Guarded so the test suite can import `convert`/`placeholderOrder`/`KEYS`
// above without this CLI running the (real) --check/write logic as a side
// effect of the import.
if (import.meta.main) {
  const check = process.argv.includes("--check");
  const next = build();

  if (check) {
    let current = "";
    try {
      current = readFileSync(OUT, "utf8");
    } catch {
      /* a missing file is a mismatch */
    }
    if (current !== next) {
      console.error(
        "Localizable.xcstrings is stale. Run native/scripts/gen-strings.sh and commit the result.",
      );
      process.exit(1);
    }
    console.log(`Localizable.xcstrings is up to date (${KEYS.length} keys).`);
  } else {
    writeFileSync(OUT, next, "utf8");
    console.log(`Wrote ${OUT} (${KEYS.length} keys, en + de).`);
  }
}
