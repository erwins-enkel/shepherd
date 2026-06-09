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
  // Pins the unpacked-load extension ID to a constant
  // (bflahkibnmcbijbhelmpjbohpfhlbaig) so the server's SHEPHERD_ALLOWED_HOSTS
  // allowlist entry is set once and never drifts per directory/machine. This is
  // the base64 DER SPKI of an RSA keypair; only the public half lives here (the
  // private key is kept out of the repo, needed only to re-pack a .crx later).
  //
  // Re-derive the ID from this key to confirm it matches the README/allowlist:
  //   node -e 'const c=require("crypto"),der=Buffer.from(KEY,"base64"); \
  //     console.log([...c.createHash("sha256").update(der).digest("hex").slice(0,32)] \
  //       .map(h=>String.fromCharCode(97+parseInt(h,16))).join(""))'
  // (SHA-256 of the DER bytes → first 16 bytes → each hex nibble 0-f mapped to a-p.)
  key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAso7Zwr/ekV8ZuPryegqmJNFxRCCrM32ddBctJz9Z4+j6MA4vdOKi8wgCj5nphcBgxQaQxltQE2HrEJ80g2UdthQlQ59qDO7aTWvoPzxcNssASgPWlNJyzGzhyokxO3VdCSGp4z6brlHa0x2MRrfxWOTUvLgDH44h5pKXhc/tn2G/dlLvaQ5YY0IijQD194GhaFLPmdj9f2PEsEV9D16wCo/qbREW8lvIE9WsFZHgJIIvMakl7udzzq8RBz2wkXltGuM1ZPo5oX0YoIlM9KZ+6CjiGrrcgNcm/q6Lwx98TWnums23Qq/MBrOFelhRalgHZvwU4zjic64RoGnMQU+5twIDAQAB",
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
