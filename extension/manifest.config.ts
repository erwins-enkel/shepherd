import { defineManifest } from "@crxjs/vite-plugin";

// Phase 1 MVP manifest.
//
// i18n: `name`/`default_title` are the untranslated product name (brand). The
// `description` IS translatable chrome, so it's localized MV3-native via
// `default_locale` + `__MSG_*__` resolved from `public/_locales/{en,de}/`. (The
// popup/options chrome is localized separately through Paraglide.)
//
// host_permissions: Phase 1 talks to the LOCAL core only (`http://localhost:7330`).
// Remote/Tailscale (`*.ts.net`) needs an optional-host-permission request flow
// (`optional_host_permissions` + `chrome.permissions.request`) — deferred to a
// later phase; the options UI + README are scoped to localhost accordingly.
export default defineManifest({
  manifest_version: 3,
  name: "Shepherd Capture",
  version: "0.0.1",
  default_locale: "en",
  description: "__MSG_ext_description__",
  action: {
    default_title: "Shepherd Capture",
    default_popup: "index.html",
  },
  options_page: "options.html",
  background: {
    service_worker: "src/background.ts",
    type: "module",
  },
  permissions: ["activeTab", "scripting", "tabs", "storage"],
  host_permissions: ["http://localhost:7330/*"],
});
