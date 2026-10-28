// Types for the Codex PATH shim (scripts/slot-shim.mjs, #3550); declared so the TypeScript tests
// and src/slot-shims.ts can import it.

export interface SlotShimDeps {
  shimDir?: string | null;
  findReal?: (tool: string, path: string | undefined, skipDir: string | null) => string | null;
  isHeavy?: (command: string, cwd: string) => boolean;
  runSlot?: (argv: string[], env: Record<string, string | undefined>) => Promise<number>;
  execReal?: (
    file: string,
    args: string[],
    env: Record<string, string | undefined>,
  ) => Promise<number>;
}

export function shellQuote(word: string): string;
export function findReal(
  tool: string,
  path: string | undefined,
  skipDir: string | null,
): string | null;
export function main(
  argv: string[],
  env?: Record<string, string | undefined>,
  deps?: SlotShimDeps,
): Promise<number>;
