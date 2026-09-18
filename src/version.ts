import pkg from "../package.json" with { type: "json" };

/** Root package.json version, resolved at build time by the same static JSON import src/telemetry.ts
 *  uses — so a bundled/compiled server carries the version instead of hunting for the file at
 *  runtime. release-please bumps package.json, so this is the single source for "which Shepherd is
 *  this" (health endpoint, native client checks). */
export const SHEPHERD_VERSION: string = pkg.version;
