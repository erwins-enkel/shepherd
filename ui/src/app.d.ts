// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
  // injected at build time by vite.config.ts (`define`)
  const __GIT_SHA__: string;
  const __APP_VERSION__: string;
  const __RELEASE_DATES__: Record<string, string>;
  const __DEMO__: boolean;

  namespace App {
    /**
     * Shape returned by `handleError` (hooks.client.ts) and read by `+error.svelte`.
     * `kind` lets the error page tell a retryable transport failure apart from an app fault
     * without re-parsing the message string in the component.
     */
    interface Error {
      message: string;
      kind?: import("$lib/client-error").ClientErrorKind;
    }
    // interface Locals {}
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
