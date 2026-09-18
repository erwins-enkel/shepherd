# Shepherd native client contract

`openapi.yaml` is the **only** description of the server surface the native macOS/iOS client
(`native/`) may use. Swift models and client stubs are generated from it; nothing about the server
is hand-typed on the Swift side.

**What it covers.** Health and version, password login and access tokens, the first-run settings
handshake, sessions (list, detail, create, archive, interrupt), repos, the `/events` WebSocket
catalogue and the `/pty/{id}` terminal protocol. Everything else the web UI does is out of the
contract until a native feature needs it.

**How it stays true.** `test/contract/openapi.test.ts` starts the real server in-process with the
same stubbed herdr the other server tests use, calls every operation in the file, and validates
each response with ajv. It also watches `/events` and validates the frames. A coverage gate fails
the run if the contract declares a route, status or event the test never saw, so the file cannot
grow untested surface. Events that only a live herdr would emit are fed through the server's own
`EventHub` from fixtures typed with the server's TypeScript types (`test/contract/event-fixtures.ts`),
so a type change breaks `bun run typecheck` before it can drift. Each fixture is typed with the
server's own type where one exists (`BlockReason`, `AutoMergeStatus`, `UsageLimits`,
`SessionStatus`) and structurally otherwise.

**How to extend it.** Add the schema under `components.schemas`, the path or event, then the test
that exercises every declared status. Run `bun run test:contract`. Regenerate the Swift client in
`native/` afterwards (its CI job fails if generated code is stale).

**Rules.** Server-produced objects use `additionalProperties: true` so the client tolerates new
fields. Request bodies use `additionalProperties: false` because the server rejects unknown keys.
Enums are copied verbatim from `src/types.ts`, `src/sandbox.ts`, `src/blocked.ts` and
`src/token-scopes.ts`.

**Deliberately undeclared.** `415` (wrong content type) and `400` for malformed JSON are not
declared on POST/PUT routes because the generated client always sends valid JSON. `403
insufficient_scope` (non-`full` tokens) is not declared because the native client mints `full`
tokens. `403` from a sandbox auto-refusal on `POST /api/sessions` is reachable in production but
undeclared because the harness cannot drive it without real sandbox machinery. The client must
treat any undeclared 4xx/5xx as a generic server error.
