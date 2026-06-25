// Single-operator auth UI state (issue #1079). `unauthenticated` flips true when any API call is
// rejected with 401 (the interceptor in api.ts) or after an explicit logout; the root layout swaps
// to the login view while it's set. `checked` gates first paint: the layout renders the app (or the
// login view) only after the boot `/api/me` probe resolves, so there's no flash of failing calls.
class AuthState {
  unauthenticated = $state(false);
  checked = $state(false);
}

export const auth = new AuthState();
