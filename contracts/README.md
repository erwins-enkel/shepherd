# Shepherd native client contract

`openapi.yaml` is the **only** description of the server surface the native macOS/iOS client
(`native/`) may use. Swift models and client stubs are generated from it; nothing about the server
is hand-typed on the Swift side.

**What it covers.** Health and version, password login and access tokens, the first-run settings
handshake, sessions (list, detail, create, archive, interrupt), repos, the `/events` WebSocket
catalogue and the `/pty/{id}` terminal protocol. Everything else the web UI does is out of the
contract until a native feature needs it. The spec calls the terminal block `x-shepherd-protocol`;
here it is `x-shepherd-pty`, next to `x-shepherd-events`, so the two socket catalogues read as a
pair.

**How it stays true.** `test/contract/openapi.test.ts` starts the real server in-process with the
same stubbed herdr the other server tests use, calls every operation in the file, and validates
each response with ajv. It also watches `/events` and validates the frames. A coverage gate fails
the run if the contract declares a route, status or event the test never saw, so the file cannot
grow untested surface. Events that only a live herdr would emit are fed through the server's own
`EventHub` from fixtures in `test/contract/event-fixtures.ts`, each typed with the server's own
type where one exists (`BlockReason`, `AutoMergeStatus`, `UsageLimits`, `SessionStatus`) and
structurally otherwise — so a type change breaks `bun run typecheck` before it can drift.

**How to extend it.** Add the schema under `components.schemas`, the path or event, then the test
that exercises every declared status. Run `bun run test:contract` and `bun run gen:contract-swift`,
and commit the regenerated `openapi.swift.yaml` alongside your change.

## Generator compatibility

There are two files here and they are not interchangeable:

- **`openapi.yaml` is the truth.** It describes the wire exactly, in whatever JSON Schema says it,
  and it is what the ajv drift test validates the live server against. Nothing rewrites it for a
  tool's convenience.
- **`openapi.swift.yaml` is generator input, derived mechanically** by
  `scripts/gen-contract-swift.ts`. **Swift is generated ONLY from `openapi.swift.yaml`** — never
  from the truth file, which Apple's [swift-openapi-generator][gen] cannot consume.

Four constructs are rewritten, each for an upstream limitation:

| In `openapi.yaml`             | In `openapi.swift.yaml`                              | Why                              |
| ----------------------------- | ---------------------------------------------------- | -------------------------------- |
| `oneOf: [X, {type: "null"}]`  | `X`, and the property leaves `required`              | generator issue #817             |
| `null` inside an `enum` array | the `null` member dropped                            | generator issue #118             |
| `const: <value>`              | the keyword deleted                                  | generator issue #261             |
| `x-shepherd-open-enum: true`  | `anyOf: [{type: string, enum: […]}, {type: string}]` | generated Swift enums are closed |

A Swift optional decodes JSON `null` as `nil` via `decodeIfPresent`, so collapsing a nullable union
and dropping the property from `required` is lossless for the client. The dropped `const` values are
still asserted at runtime by the contract test. `null` members removed from an `enum` are always
redundant with the `type: [x, "null"]` array the generator does support.

**Open enums.** Generated Swift enums are closed: an unknown member is a decode failure, which for a
shipped client means a whole response is lost. `SessionStore.hydrate` (`src/store.ts`) spreads raw
SQLite values for `status`, `lastState`, `planPhase` and `haltReason` straight onto the wire without
re-validating them, so a row written by a newer (or hand-edited) Shepherd can carry a member this
client has never heard of. Every **read-side** enum is therefore flagged `x-shepherd-open-enum` —
`SessionStatus`, `HerdrState`, `SessionArchiveReason`, `ExperimentRole`, `EventName`, the inline
`Session.planPhase`/`Session.haltReason`, and `BlockReason`'s `shape`/`quotaKind`. The **request-side**
enums stay closed (`AgentProvider`, `SandboxProfile`, `TokenScope`, `Effort`): the client chooses
those values, so a closed Swift enum is the point.

**Staying fresh.** `bun run gen:contract-swift` regenerates the derived file;
`bun run check:contract-swift` regenerates and fails on any diff (same pattern as
`check:herdr-types`). `test/contract/swift-derivation.test.ts` asserts the same thing under
`bun run test`, plus that none of the four constructs survived and that every operationId and
component schema of the truth file is still present. The `native/` regeneration target and the
`native.yml` CI freshness job that runs it are **planned for sub-project 2** and are not on this
branch yet.

[gen]: https://github.com/apple/swift-openapi-generator

## Rules

Server-produced objects use `additionalProperties: true` so the client tolerates new fields.
Request bodies use `additionalProperties: false`: that states what the generated client sends, not
what the server tolerates — only token minting actually rejects unknown keys (`POST
/api/access-tokens` answers 400), while the other routes ignore them. Enums are copied verbatim
from `src/types.ts`, `src/sandbox.ts`, `src/blocked.ts` and `src/token-scopes.ts`, and pinned to
those constants by a test.

**Deliberately undeclared.** `415` (wrong content type) and `400` for malformed JSON are not
declared on POST/PUT routes because the generated client always sends valid JSON. `403
insufficient_scope` (non-`full` tokens) is not declared because the native client mints `full`
tokens. `403` from a sandbox auto-refusal on `POST /api/sessions` is reachable in production but
undeclared because the harness cannot drive it without real sandbox machinery. The client must
treat any undeclared 4xx/5xx as a generic server error.
