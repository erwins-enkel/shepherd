/**
 * Server env vars selecting the github.com token task agents get instead of the operator's own
 * (`gh auth token`). Dependency-free so the membrane flag builder (sandbox.ts) can ask whether an
 * agent mode is configured without importing the token sources.
 */

/** File holding one dedicated agent token (see membrane-state.ts `agentGhTokenFromEnv`). */
export const AGENT_GH_TOKEN_FILE_ENV = "SHEPHERD_AGENT_GH_TOKEN_FILE";
/** GitHub App mode: the App's numeric App ID (see agent-gh-app.ts). */
export const AGENT_GH_APP_ID_ENV = "SHEPHERD_AGENT_GH_APP_ID";
/** GitHub App mode: path to the App's PEM private key, which must be `chmod 600`. */
export const AGENT_GH_APP_KEY_FILE_ENV = "SHEPHERD_AGENT_GH_APP_KEY_FILE";

/**
 * Permissions a session gets only on an explicit operator grant (#4119), on top of
 * `AGENT_GH_APP_PERMISSIONS` (agent-gh-app.ts). `workflows: write` lets a push create or update
 * `.github/workflows/*` — new triggers, wider `permissions:`, new secret references — so it is
 * never in the default set.
 */
export const GH_OPT_IN_PERMISSIONS = { workflows: "write" } as const;

export type GhOptInPermission = keyof typeof GH_OPT_IN_PERMISSIONS;

export function isGhOptInPermission(v: unknown): v is GhOptInPermission {
  return typeof v === "string" && Object.hasOwn(GH_OPT_IN_PERMISSIONS, v);
}

/** An opt-in grant on a session (#4119): which permission, when, and by whom. */
export interface GhGrant {
  permission: GhOptInPermission;
  grantedAt: number;
  /** `operator` (cookie session) or `token:<name>` (an access token). */
  grantedBy: string;
}

type Env = Record<string, string | undefined>;

const isSet = (env: Env, k: string) => !!env[k]?.trim();

/** GitHub App mode is configured: either App var is set (half a config still counts — it fails
 *  closed rather than falling through to a lower token source). */
export function agentGhAppConfigured(env: Env = process.env): boolean {
  return isSet(env, AGENT_GH_APP_ID_ENV) || isSet(env, AGENT_GH_APP_KEY_FILE_ENV);
}

/** Any agent token mode is configured — App mode or the token file. From then on the operator's
 *  own token must never reach a membrane, not even through the host `hosts.yml`. */
export function agentGhModeConfigured(env: Env = process.env): boolean {
  return agentGhAppConfigured(env) || isSet(env, AGENT_GH_TOKEN_FILE_ENV);
}
