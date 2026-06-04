import { defineManifest } from "@crxjs/vite-plugin";

// Phase 1 MVP manifest. Title is the untranslated product name (see spec i18n
// section). host_permissions defaults to the local Shepherd core; users widen
// it to a ts.net URL via the browser's optional-host prompt in a later phase —
// for MVP the localhost default plus activeTab capture suffices.
export default defineManifest({
  manifest_version: 3,
  name: "Shepherd Capture",
  version: "0.0.1",
  description: "Capture the current tab into a Shepherd task.",
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
