import { defineManifest } from "@crxjs/vite-plugin";

// Capture extension manifest.
//
// i18n: `name`/`default_title` are the untranslated product name (brand). The
// `description` IS translatable chrome, so it's localized MV3-native via
// `default_locale` + `__MSG_*__` resolved from `public/_locales/{en,de}/`. (The
// popup/options chrome is localized separately through Paraglide.)
//
// host_permissions: the LOCAL core (`http://localhost:7330`) is granted
// statically. A remote core reached over Tailscale (`https://*.ts.net`) is an
// OPTIONAL host permission, requested on demand via `chrome.permissions.request`
// from the options Save gesture (see src/lib/remote-host.ts) — so the shipped
// capture phases can be exercised against a remote Shepherd over Tailscale.
//
// commands: `_execute_action` is a RESERVED Chrome command that opens the action
// popup with zero background code (Alt+Shift+S; rebindable at
// chrome://extensions/shortcuts). It carries no `description` — Chrome
// auto-labels reserved commands — so there's no onCommand listener and no i18n key.
//
// icons / action.default_icon: the branded Shepherd sheep mark, rendered from the
// UI favicon (ui/static/favicon.svg) into public/icons/icon-{16,32,48,128}.png and
// copied verbatim into dist by crxjs. `icons` is the install/management surface;
// `default_icon` is the toolbar button.
export default defineManifest({
  manifest_version: 3,
  name: "Shepherd Capture",
  version: "0.0.1",
  default_locale: "en",
  description: "__MSG_ext_description__",
  icons: {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png",
  },
  commands: {
    _execute_action: {
      suggested_key: { default: "Alt+Shift+S" },
    },
  },
  action: {
    default_title: "Shepherd Capture",
    default_popup: "index.html",
    default_icon: { "16": "icons/icon-16.png", "32": "icons/icon-32.png" },
  },
  options_page: "options.html",
  background: {
    service_worker: "src/background.ts",
    type: "module",
  },
  permissions: ["activeTab", "scripting", "tabs", "storage"],
  host_permissions: ["http://localhost:7330/*"],
  // Requested on demand (chrome.permissions.request), never granted at install:
  // - `https://*.ts.net/*` — the configured remote (Tailscale) Shepherd core,
  //   requested from the options Save gesture when the base URL is a ts.net host.
  // - `<all_urls>` — the console/network recorder content script, requested when
  //   the user enables recording in options.
  optional_host_permissions: ["https://*.ts.net/*", "<all_urls>"],
});
