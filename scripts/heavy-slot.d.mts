// Types for the node-run heavy-check runner (scripts/heavy-slot.mjs, #3181). The runner stays
// plain .mjs so it runs under the node binary the sandbox membrane already binds; this
// declaration only exists so the TypeScript test (test/heavy-slot-runner.test.ts) can import it.

export const EXIT_QUEUED: number;

export function commandFrom(argv: readonly string[]): string | null;

export function ingressConfig(
  env: Record<string, string | undefined>,
  readFile?: (path: string) => string,
): { endpoint: string; header: [string, string] } | null;

export function main(argv?: string[], env?: Record<string, string | undefined>): Promise<number>;
