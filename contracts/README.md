# Shepherd client contract

`openapi.yaml` is the **only** description of the server surface the native macOS/iOS client
(`native/`) and the `shepherd` CLI (epic #2487) may use. Swift models and client stubs, and the
CLI's Rust client, are generated from it; nothing about the server is hand-typed on either side.

**What it covers.** Health and version, password login and access tokens, the first-run settings
handshake, sessions (list, detail, create, archive, interrupt), repos, the `/events` WebSocket
catalogue and the `/pty/{id}` terminal protocol. Everything else the web UI does is out of the
contract until a native or CLI feature needs it.

**The v1 CLI surface** is `getHealth` (its `version` drives the CLI's version-mismatch warning),
`listSessions`, `getSession`, `getHolds`, `gitStates`, `listReviewsInflight`, `createSession`,
`replySession` (steer), `interruptSession`, `archiveSession` (`DELETE /api/sessions/{id}`) and
`resumeSession`, plus every `session:*` frame on `/events` for `shepherd events tail`.
`test/contract/rust-derivation.test.ts` pins that list. The spec calls the terminal block `x-shepherd-protocol`;
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

An operation's `security` block is part of that truth: `DELETE /api/access-tokens/{id}` lists both
`cookieAuth` and `bearerAuth` because a bearer token may revoke **itself** (and only itself) without
an operator session, and the contract test exercises that self-revoke alongside the 403 a bearer
gets for any other id. That self-revoke case is a hand-written addition to the contract test, not
something the coverage gate enforces on its own — the gate only checks that every declared route,
status and event was exercised, not that a `security` block's actual meaning was. OpenAPI's
`security` list is an **either-of**: naming `cookieAuth` and `bearerAuth` says "either credential is
accepted here", which is looser than the real rule ("a bearer may act only on the id it authenticated
as"). The narrower rule has no field to live in — it lives in the operation's `description` and in
`revokesItself`/`scopeAllows` (src/server.ts, src/token-scopes.ts), which is why the hand-written
test case matters: it is what actually pins the narrow behavior down.

**How to extend it.** Add the schema under `components.schemas`, the path or event, then the test
that exercises every declared status. Run `bun run test:contract`, `bun run gen:contract-swift` and
`bun run gen:contract-rust`, then `native/scripts/sync-contract.sh` to copy the Swift spec into
ShepherdKit, and commit the regenerated `openapi.swift.yaml`, `openapi.rust.yaml` and
`native/Sources/ShepherdKit/openapi.yaml` alongside your change.

## Stream blocks — three per stream

Milestone 2 was built by four parallel streams (`terminal`, `detail`, `sidebar`, `actions`) and
milestone 3 adds six more (`herd`, `plan`, `merge`, `queues`, `compose`, `settings`). Each owns a
marked block in **all three** extensible sections of `openapi.yaml`:

| Section               | What goes in the block         |
| --------------------- | ------------------------------ |
| `components.schemas:` | the stream's component schemas |
| `paths:`              | the stream's path templates    |
| `x-shepherd-events:`  | the stream's `/events` frames  |

```yaml
# ── stream: sidebar ──
# ── /stream: sidebar ──
```

One grammar for all three: a single literal space at each gap, the ten streams always in the
order above, the blocks last in their section. Appending inside your own block turns two branches
that both add surface into an insertion conflict resolved by keeping both blocks, rather than a
fight over the same trailing lines. `test/contract/stream-blocks.ts` parses them out of the raw
text (a YAML parse drops comments) and `test/contract/stream-blocks.test.ts` guards the markers:
they must be balanced, never nested, and every one of the thirty pairs must be present and in
order. **Never edit another stream's block, and never add surface outside one if you are a
stream.**

Coverage is split along the same line. The gate at the end of `openapi.test.ts` polices only what
sits **outside** the markers — `streamOwnedPaths()` and `streamOwnedEvents()` are subtracted from
it — because Bun runs test files in filesystem order and this file may run before a stream's own.
A stream covers its own block from its own `test/contract/<stream>.test.ts`, ending it with a gate
over `operationsForStream("<stream>")` and `eventsForStream("<stream>")`, and exercising every
status it declares — 401 included — from that same file.

## Generator compatibility

There are three files here and they are not interchangeable:

- **`openapi.yaml` is the truth.** It describes the wire exactly, in whatever JSON Schema says it,
  and it is what the ajv drift test validates the live server against. Nothing rewrites it for a
  tool's convenience.
- **`openapi.swift.yaml` is generator input, derived mechanically** by
  `scripts/gen-contract-swift.ts`. **Swift is generated ONLY from `openapi.swift.yaml`** — never
  from the truth file, which Apple's [swift-openapi-generator][gen] cannot consume.
- **`openapi.rust.yaml` is generator input, derived mechanically** by
  `scripts/gen-contract-rust.ts` for [progenitor][progenitor], which reads only OpenAPI 3.0. See
  [Rust derivation](#rust-derivation).

Four constructs are rewritten, each for an upstream limitation:

| In `openapi.yaml`             | In `openapi.swift.yaml`                        | Why                              |
| ----------------------------- | ---------------------------------------------- | -------------------------------- |
| `oneOf: [X, {type: "null"}]`  | `X`, and the property leaves `required`        | generator issue #817             |
| `null` inside an `enum` array | the `null` member dropped                      | generator issue #118             |
| `const: <value>`              | the keyword deleted                            | generator issue #261             |
| `x-shepherd-open-enum: true`  | `anyOf: [{$ref: <Name>Known}, {type: string}]` | generated Swift enums are closed |

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

A flagged **component** splits in two: `<Name>Known` carries the closed enum and `<Name>` becomes
`anyOf: [$ref <Name>Known, {type: string}]`, so Swift gets a real `SessionStatusKnown` enum to
switch over instead of an anonymous inline payload. A flagged **inline** property schema
(`Session.planPhase`, `Session.haltReason`, `BlockReason.shape`/`quotaKind`) keeps the inline
`anyOf: [{type: string, enum: […]}, {type: string}]` — there is no name to generate a type from.

**The derivation is strict.** It walks schema positions only — `components.schemas` values,
`properties`/`items`/`additionalProperties`/`allOf`/`anyOf`/`oneOf`/`not` inside a schema, and any
`schema` value — so the keys of a `properties` map are names, never keywords, and a property called
`const` or `oneOf` survives untouched. Where it cannot rewrite a construct faithfully it throws with
the offending JSON pointer rather than weakening the contract: a nullable union is collapsed only
under `properties` (the one place the enclosing `required` can be relaxed) and only when nothing but
annotations sit beside it, and a nullable union or flagged enum inside `allOf` is an error. Adding
such a shape to the truth file therefore fails `bun run gen:contract-swift` loudly instead of
silently shipping a Swift model that cannot represent `null`.

**Staying fresh.** `bun run gen:contract-swift` regenerates the derived file;
`bun run check:contract-swift` regenerates and fails on any diff (same pattern as
`check:herdr-types`). `test/contract/swift-derivation.test.ts` asserts the same thing under
`bun run test`, plus that none of the four constructs survived and that every operationId and
component schema of the truth file is still present. Verified on 2026-09-18 with
swift-openapi-generator 1.13.1: the derived file builds with zero unsupported-schema warnings. The
`native/` regeneration target and the `native.yml` CI freshness job that runs it are **planned for
sub-project 2** and are not on this branch yet.

## Rust derivation

`openapi.rust.yaml` is OpenAPI 3.0.3. The CLI's client is generated from it and never from the
truth file. The schema walk is the same shape as the Swift one: it rewrites only where a schema
lives, treats `properties` keys as names, and throws with a JSON pointer rather than weakening the
contract.

| In `openapi.yaml`                                     | In `openapi.rust.yaml`                                          |
| ----------------------------------------------------- | --------------------------------------------------------------- |
| `openapi: 3.1.0`                                      | `openapi: 3.0.3`                                                |
| `type: [T, "null"]`                                   | `type: T`, `nullable: true`                                     |
| `oneOf: [$ref X, {type: "null"}]`                     | `allOf: [$ref X]`, `nullable: true` (3.0 `$ref` drops siblings) |
| `const: v`                                            | `enum: [v]`                                                     |
| `null` inside an `enum` array                         | dropped (nullability rides on `nullable`)                       |
| `x-shepherd-open-enum: true`                          | the `enum` list dropped: a plain string                         |
| differing bodies across one operation's 2xx or errors | one `<OperationId>Success`/`Error` `oneOf` component            |

**Open enums are plain strings.** typify's generated enums are closed, so an unknown member would
fail the whole response. Request-side enums stay closed, as on the Swift side.

**One body type per response group.** progenitor asserts that an operation has one success type and
one error type. Where the truth answers different bodies (`createSession` answers `HeldTask` on 200
and `Session` on 201), the derivation adds a `oneOf` component that every response in the group
references. typify turns it into an untagged enum, with the generic `Error` ordered last. An error
group that mixes bodyless and JSON responses loses its body schemas instead, and the client gets the
raw body. A success group like that throws.

**Excluded operations** live in `RUST_EXCLUDED_OPERATIONS` with their reason. Today that is only
`uploadFile`, because progenitor 0.15 rejects `multipart/form-data`. The derivation test fails if a
v1 CLI operation is ever excluded.

**Staying fresh.** `bun run gen:contract-rust` regenerates the file. `bun run check:contract-rust`
regenerates it and fails on any diff; CI runs it. `test/contract/rust-derivation.test.ts` asserts the
same under `bun run test`, plus that no 3.1 construct survives and no operation still has more than
one body type per group. Verified on 2026-09-25 with progenitor 0.15.0 (typify 0.8.0): the
generated client builds without warnings, decodes `GET /api/health` from a live server, decodes an
unknown `SessionStatus`, and picks the `HeldTask` variant of `CreateSessionSuccess`. The `cli/` crate
generates its client from this file in `cli/build.rs` on every build, so the `cli` CI job
(`scripts/check-cli.sh`) is the gate that a contract change still yields a client the CLI compiles
against.

[gen]: https://github.com/apple/swift-openapi-generator
[progenitor]: https://github.com/oxidecomputer/progenitor

## Rules

Server-produced objects use `additionalProperties: true` so the client tolerates new fields.
Request bodies use `additionalProperties: false`: that states what the generated client sends, not
what the server tolerates. Two routes actually reject an unknown key with 400 — `POST
/api/access-tokens`, and `POST /api/sessions`, which answers `unknown key: …` for anything outside
`ALLOWED_KEYS` (`src/validate.ts`). `POST /api/login` and `PUT /api/settings` ignore unknown keys.
Enums are copied verbatim from `src/types.ts`, `src/sandbox.ts`, `src/blocked.ts` and
`src/token-scopes.ts`, and pinned to those constants by a test.

`Health.minClient` is a forward-compatibility placeholder: it is declared (and optional) so a
future server can name the lowest native client version it supports without a contract change. No
server emits it today, so the client must treat its absence as "no constraint".

**Deliberately undeclared.** `415` (wrong content type) and `400` for malformed JSON are not
declared on POST/PUT routes because the generated client always sends valid JSON. `403
insufficient_scope` (non-`full` tokens) is not declared because the native client mints `full`
tokens. `403` from a sandbox auto-refusal on `POST /api/sessions` is reachable in production but
undeclared because the harness cannot drive it without real sandbox machinery. The client must
treat any undeclared 4xx/5xx as a generic server error.
