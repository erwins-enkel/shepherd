import { expect, test } from "bun:test";
import { join } from "node:path";
import { config } from "../src/config";
import {
  isApiKeyMode,
  isApiKeyConfigured,
  apiKeySettingsFragment,
  apiKeyMembraneFields,
  apiKeyPassthroughEnv,
} from "../src/spawn-auth";

// Helper: run `fn` with config auth fields temporarily set, always restoring them.
function withAuth(mode: typeof config.authMode, helper: string | null, fn: () => void): void {
  const prevMode = config.authMode;
  const prevPath = config.authApiKeyHelperPath;
  try {
    config.authMode = mode;
    config.authApiKeyHelperPath = helper;
    fn();
  } finally {
    config.authMode = prevMode;
    config.authApiKeyHelperPath = prevPath;
  }
}

// ── isApiKeyMode / isApiKeyConfigured ───────────────────────────────────────

test("isApiKeyMode reflects config.authMode only", () => {
  withAuth("subscription", null, () => expect(isApiKeyMode()).toBe(false));
  withAuth("subscription", "/h.sh", () => expect(isApiKeyMode()).toBe(false));
  withAuth("api-key", null, () => expect(isApiKeyMode()).toBe(true));
  withAuth("api-key", "/h.sh", () => expect(isApiKeyMode()).toBe(true));
});

test("isApiKeyConfigured requires api-key mode AND a helper path", () => {
  withAuth("subscription", null, () => expect(isApiKeyConfigured()).toBe(false));
  withAuth("subscription", "/h.sh", () => expect(isApiKeyConfigured()).toBe(false));
  withAuth("api-key", null, () => expect(isApiKeyConfigured()).toBe(false));
  withAuth("api-key", "/h.sh", () => expect(isApiKeyConfigured()).toBe(true));
});

// ── apiKeySettingsFragment ──────────────────────────────────────────────────

test("apiKeySettingsFragment is {} for subscription (byte-for-byte)", () => {
  withAuth("subscription", "/h.sh", () => expect(apiKeySettingsFragment()).toEqual({}));
});

test("apiKeySettingsFragment is {} for api-key-unconfigured (no helper)", () => {
  withAuth("api-key", null, () => expect(apiKeySettingsFragment()).toEqual({}));
});

test("apiKeySettingsFragment carries apiKeyHelper for api-key-configured", () => {
  withAuth("api-key", "/path/helper.sh", () =>
    expect(apiKeySettingsFragment()).toEqual({ apiKeyHelper: "/path/helper.sh" }),
  );
});

// ── apiKeyMembraneFields ────────────────────────────────────────────────────

test("apiKeyMembraneFields: subscription → no helper, no mask", () => {
  withAuth("subscription", "/h.sh", () =>
    expect(apiKeyMembraneFields()).toEqual({ apiKeyHelperPath: null, maskCredentials: false }),
  );
});

test("apiKeyMembraneFields: api-key-unconfigured → mask on, null helper", () => {
  // Mask is keyed off mode, NOT configuration — a credential must never leak in api-key mode.
  withAuth("api-key", null, () =>
    expect(apiKeyMembraneFields()).toEqual({ apiKeyHelperPath: null, maskCredentials: true }),
  );
});

test("apiKeyMembraneFields: api-key-configured → helper path + mask on", () => {
  withAuth("api-key", "/path/helper.sh", () =>
    expect(apiKeyMembraneFields()).toEqual({
      apiKeyHelperPath: "/path/helper.sh",
      maskCredentials: true,
    }),
  );
});

// ── apiKeyPassthroughEnv ────────────────────────────────────────────────────

test("apiKeyPassthroughEnv is undefined for subscription (wrapped or not)", () => {
  withAuth("subscription", "/h.sh", () => {
    expect(apiKeyPassthroughEnv(false)).toBeUndefined();
    expect(apiKeyPassthroughEnv(true)).toBeUndefined();
  });
});

test("apiKeyPassthroughEnv is undefined when wrapped (membrane masks in place)", () => {
  withAuth("api-key", "/h.sh", () => expect(apiKeyPassthroughEnv(true)).toBeUndefined());
});

test("apiKeyPassthroughEnv returns a single CLAUDE_CONFIG_DIR key for api-key + not wrapped", () => {
  // Shape-only assertion (homedir() is OS-derived, not $HOME-overridable here): the
  // canonical mirror lives at <home>/.shepherd/claude-apikey-config — assert that
  // suffix rather than scribbling the real ~/.shepherd via an env override.
  withAuth("api-key", "/h.sh", () => {
    const env = apiKeyPassthroughEnv(false);
    expect(env).toBeDefined();
    expect(Object.keys(env!)).toEqual(["CLAUDE_CONFIG_DIR"]);
    const dir = env!.CLAUDE_CONFIG_DIR ?? "";
    expect(dir.endsWith(join(".shepherd", "claude-apikey-config"))).toBe(true);
  });
});
