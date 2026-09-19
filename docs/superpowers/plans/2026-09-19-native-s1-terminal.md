# Stream S1 — Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Shepherd for Mac a live agent terminal: a contract-backed `PTYConnection` actor in
ShepherdKit over `/pty/{id}`, a SwiftTerm view bound to it, and a prompt bar that steers the session
through `POST /api/sessions/{id}/reply`.

**Architecture:** Three layers, each in files this stream owns exclusively. (1) The contract gains
`POST /api/sessions/{id}/reply` and sharper `x-shepherd-pty` prose; a Bun drift test pins both
against the real server. (2) `PTYConnection` is an actor shaped exactly like the existing
`EventStream` — `URLSessionWebSocketTask`, bearer on the upgrade, `AsyncStream<Data>` output,
`lifecycle()`, capped-backoff reconnect — with the PTY's own close-code policy (4000 superseded and
4001 gone never reconnect). (3) The app wraps that actor in a `@MainActor` adapter behind a
`PTYAttaching` protocol so `TerminalSessionModel`, a plain `@Observable` state machine, can be unit
tested without a socket; a SwiftTerm `NSViewRepresentable` and a `TerminalTab: DetailTab` render it.

**Tech Stack:** Swift 6 language mode / strict concurrency, `URLSessionWebSocketTask`,
`Network.framework` (`NWListener` + `NWProtocolWebSocket`) for the in-process PTY fake, SwiftTerm
**1.20.0** (SPM, `https://github.com/migueldeicaza/SwiftTerm`), swift-testing, XcodeGen, Bun +
ajv for the contract drift test.

## Global Constraints

- **Branch `feat/native-terminal`, cut from `origin/main`** after the S0-prep stream merges. Never
  branch off another stream's branch. Never `git merge main` — rebase. One feature per branch.
- **File ownership is a hard rule.** This stream may create or edit ONLY:
  - `native/Sources/ShepherdKit/Realtime/PTYConnection.swift`
  - `native/Sources/ShepherdKit/Client/ShepherdClient+Terminal.swift`
  - `native/Tests/ShepherdKitTests/FakePTYServer.swift`, `PTYConnectionTests.swift`,
    `ShepherdClientTerminalTests.swift`
  - `native/Apps/ShepherdMac/Sources/Terminal/**`
  - `native/Apps/ShepherdMac/Tests/TerminalStateTests.swift`
  - the `# ── stream: terminal ──` blocks in `contracts/openapi.yaml`
  - `test/contract/terminal.test.ts`
  - `KEYS_TERMINAL` in `native/scripts/gen-strings.ts` (that array only)
  - appended keys in `ui/messages/en.json` + `ui/messages/de.json`
  - `native/Apps/ShepherdMac/project.yml` — **only** the `packages:` entry and the Shepherd target's
    `dependencies:` list, nothing else in the file
  - regenerated artefacts: `contracts/openapi.swift.yaml`,
    `native/Sources/ShepherdKit/openapi.yaml`, `native/Apps/ShepherdMac/Resources/Localizable.xcstrings`
  - **Never** touch `AppModel.swift`, `MainWindow.swift`, `SessionDetailView.swift`,
    `ShepherdApp.swift`, `SessionStore.swift`, `EventStream.swift`, `FakeEventServer.swift`,
    `FakeShepherdServer.swift`, `test/contract/harness.ts`, `AppModelTests.swift`.
- **Swift 6 strict concurrency.** No `@preconcurrency import`, no `nonisolated(unsafe)` globals.
  Shared mutable state in tests uses a lock-guarded `final class … : @unchecked Sendable`.
- **ShepherdKit has no UI dependency.** No `import SwiftUI` / `AppKit` / `UIKit` anywhere under
  `native/Sources/ShepherdKit`. SwiftTerm is an **app-target** dependency only; it must never appear
  in `native/Package.swift`.
- **The contract is the only type source.** No hand-written `Codable` for server payloads. The reply
  body is a generated `Components.Schemas.ReplyRequest`. The only hand-written wire value in this
  stream is the PTY resize control frame, which the contract documents in prose, not as a schema.
- **Swift is generated from `contracts/openapi.swift.yaml`, never from `contracts/openapi.yaml`.**
  Edit the truth file, then run `bun run gen:contract-swift`, then `native/scripts/sync-contract.sh`.
  Never hand-edit the derived file or the copy inside the kit.
- **Every user-facing string goes through `L.t()`** with a key present in EN **and** DE
  (`ui/messages/en.json`, `ui/messages/de.json`) and listed in `KEYS_TERMINAL`. No literal copy in a
  view.
- **Every async completion is guarded by store identity or a generation counter.** A `Task` that
  awaits and then writes to `@Observable` state must first re-check the generation it captured
  before the await; a stale completion returns without mutating anything.
- **Logging:** `os.Logger` subsystem `run.shepherd.kit` in the kit (`ShepherdLog.realtime`),
  `run.shepherd.mac` in the app. **Never log terminal bytes, a prompt body, or a token.**
- **Commits:** conventional, lowercase subject (`feat(native): …`, `fix(contract): …`,
  `test(native): …`). Body lines ≤ 100 characters. End every commit body with
  `Co-Authored-By: <the model executing the task> <noreply@anthropic.com>`.
- **Verification commands** (exact):
  - `bun run test:contract`
  - `bun run gen:contract-swift && ./native/scripts/sync-contract.sh`
  - `swift test --package-path native --filter PTY`
  - `swift test --package-path native --filter Terminal`
  - `./native/scripts/test-app.sh -only-testing:ShepherdTests`
  - `./native/scripts/build-app.sh`
  - `bun run check:strings`
  - `cd ui && bun run check:i18n`
- **Task order is contract-first.** Task 1 always lands the contract + fixtures + drift test.

---

## File structure

| File | Responsibility |
| --- | --- |
| `contracts/openapi.yaml` (terminal block) | `POST /api/sessions/{id}/reply` path + `ReplyRequest` schema; sharpened `x-shepherd-pty` prose. |
| `test/contract/terminal.test.ts` | Drives the real server for `/reply` (200/400/404/415/401) and pins the PTY constants + upgrade behaviour. |
| `native/Sources/ShepherdKit/Realtime/PTYConnection.swift` | The `/pty/{id}` actor: URL building, bearer upgrade, `AsyncStream<Data>` output, `send`, `resize`, close-code policy, backoff, `lifecycle()`. |
| `native/Sources/ShepherdKit/Client/ShepherdClient+Terminal.swift` | `replySession(id:text:)` over the generated `replySession` operation. |
| `native/Tests/ShepherdKitTests/FakePTYServer.swift` | `NWListener` WebSocket fake that can echo, send binary, and close with an application code (4000/4001). |
| `native/Tests/ShepherdKitTests/PTYConnectionTests.swift` | Connect/auth/output/send/resize + close-code + backoff + take-over tests. |
| `native/Tests/ShepherdKitTests/ShepherdClientTerminalTests.swift` | `/reply` mapping tests against the shared `FakeShepherdServer` stub API (no edit to that file). |
| `native/Apps/ShepherdMac/Sources/Terminal/PTYAttaching.swift` | `@MainActor protocol PTYAttaching` + `LivePTYAttachment`, the adapter that hides the actor hops. |
| `native/Apps/ShepherdMac/Sources/Terminal/TerminalSessionModel.swift` | `@Observable @MainActor` state machine: phase, output fan-out, prompt send, generation guard. |
| `native/Apps/ShepherdMac/Sources/Terminal/TerminalController.swift` | `AppExtension`: one `TerminalSessionModel` per session id, torn down with the store. |
| `native/Apps/ShepherdMac/Sources/Terminal/TerminalHostView.swift` | `NSViewRepresentable` bridging SwiftTerm ↔ `TerminalSessionModel`. |
| `native/Apps/ShepherdMac/Sources/Terminal/TerminalPane.swift` | The tab body: terminal + overlay banner + prompt bar. |
| `native/Apps/ShepherdMac/Sources/Terminal/TerminalTab.swift` | `TerminalTab: DetailTab` (id `"terminal"`, order 0) + `TerminalInstall.install()`. |
| `native/Apps/ShepherdMac/Tests/TerminalStateTests.swift` | Unit tests for `TerminalSessionModel` and `TerminalTab` registration. |
| `native/Apps/ShepherdMac/project.yml` | Adds the SwiftTerm SPM package and the Shepherd target dependency. |

---

## Decisions this plan locks in (read before Task 1)

**1. SwiftTerm is pinned to `1.20.0`.** Verified from the repository's own tags
(`git ls-remote --tags https://github.com/migueldeicaza/SwiftTerm` → `v1.20.0` is the newest 1.x
tag; older ones are `v1.19.0`, `v1.18.0`, …). XcodeGen's `exactVersion` is used, not `minVersion`:
a terminal emulator's rendering and delegate surface is exactly the kind of dependency that must not
float under CI.

**2. The PTY fake is a NEW file, not an extension of `FakeEventServer`.** `FakeEventServer.swift` is
shared with the kit's `/events` tests and is not in this stream's ownership list. `FakePTYServer` is
a near-copy specialised for the PTY protocol: it records the upgrade path and query, echoes client
text, can push binary frames, and can close with `NWProtocolWebSocket.CloseCode.applicationCode`
(the 4000–4999 range `.protocolCode` cannot express). The duplication is deliberate and cheap; the
integration lane may fold them together later.

**3. Close codes are read from `task.closeCode.rawValue`.** `URLSessionWebSocketTask` exposes the
peer's close code there once the socket is gone, which is the only place 4000/4001 surface without a
delegate. **Task 3's first test is the arbiter.** If that test shows `rawValue` reporting `0` for a
4000 close instead of `4000`, switch to the delegate form given verbatim in Task 3's contingency
block — do not weaken the test.

**4. `TerminalSessionModel` never talks to `PTYConnection` directly.** It holds a `PTYAttaching`, a
`@MainActor` protocol with synchronous methods. `LivePTYAttachment` wraps the actor and does the
`Task { await … }` hops. That is what makes the state machine unit-testable with `Gate`/`settle` and
no socket, and it keeps every actor hop in one small file.

**5. The tab and extension register from `TerminalInstall.install(into:)`, which this stream owns.**
Swift has no `+load`, so one line must call it. S0-prep created
`native/Apps/ShepherdMac/Sources/App/StreamRegistrations.swift` as exactly that call site, and it
belongs to the **integration lane (S0-int)** — "wires the slot, one small commit". This stream's
tests call `TerminalInstall.install(into:)` themselves, so registration is proven here without
touching a shared file. Task 8 puts the exact line in the PR body.

**6. The seam signatures come from the S0-prep plan, not from Appendix B.** Three differ:
`register` is an instance method on `AppModel` (`app.register(TerminalController.self)`), the
accessor is `` app.`extension`(_:) `` with backticks, and `DetailTabRegistry.register` is already
last-wins per id (plus a `reset()` for tests). Verify these against the merged S0-prep before
Task 7; if any changed, only `TerminalTab.swift` and its two tests need touching.

---

## Task 1: Contract — `POST /api/sessions/{id}/reply` and the PTY prose

**Files:**
- Modify: `contracts/openapi.yaml` (inside `# ── stream: terminal ──` blocks under `paths:` and
  `components.schemas:`; and the `x-shepherd-pty` block at the end)
- Create: `test/contract/terminal.test.ts`
- Regenerate: `contracts/openapi.swift.yaml`, `native/Sources/ShepherdKit/openapi.yaml`

**Interfaces:**
- Consumes: nothing.
- Produces: generated Swift `Components.Schemas.ReplyRequest` (one required `text: String`) and the
  generated operation `replySession(.init(path: .init(id:), body: .json(.init(text:))))` with cases
  `.ok`, `.badRequest`, `.unauthorized`, `.notFound`, `.unsupportedMediaType`, `.undocumented`.
  Task 4 uses these exact names.

- [ ] **Step 1: Write the failing contract test**

Create `test/contract/terminal.test.ts`:

```ts
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { RESIZE_PREFIX } from "../../src/operator-activity";
import { PTY_GONE_CODE, PTY_SUPERSEDED_CODE } from "../../src/server";
import {
  bearer,
  loadContract,
  login,
  mintToken,
  restoreAuth,
  startContractServer,
  validateResponse,
  withAuth,
  type ContractServer,
} from "./harness";

let s: ContractServer;
let token: string;

beforeAll(async () => {
  await withAuth();
  s = startContractServer();
  const cookie = await login(s);
  ({ token } = await mintToken(s, cookie));
});
afterAll(() => {
  try {
    s?.stop();
  } finally {
    restoreAuth();
  }
});

const reply = (id: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${s.baseUrl}/api/sessions/${id}/reply`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(token), ...headers },
    body: JSON.stringify(body),
  });

describe("POST /api/sessions/{id}/reply", () => {
  test("an unknown id is a contract-shaped 404", async () => {
    const res = await reply("no-such-session", { text: "hello" });
    expect(res.status).toBe(404);
    await validateResponse("POST", "/api/sessions/{id}/reply", res);
  });

  test("a body without text is a contract-shaped 400", async () => {
    const res = await reply("no-such-session", { nope: 1 });
    expect(res.status).toBe(400);
    await validateResponse("POST", "/api/sessions/{id}/reply", res);
  });

  test("a non-JSON content type is a contract-shaped 415", async () => {
    const res = await reply("no-such-session", { text: "hi" }, { "content-type": "text/plain" });
    expect(res.status).toBe(415);
    await validateResponse("POST", "/api/sessions/{id}/reply", res);
  });

  test("no credential is a contract-shaped 401", async () => {
    const res = await fetch(`${s.baseUrl}/api/sessions/x/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(401);
    await validateResponse("POST", "/api/sessions/{id}/reply", res);
  });

  test("the declared request schema is the one the server accepts", () => {
    const schema = loadContract().components.schemas.ReplyRequest as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(["text"]);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toEqual(["text"]);
  });
});

describe("x-shepherd-pty documents what the native client relies on", () => {
  test("the constants still match the server", () => {
    const pty = loadContract()["x-shepherd-pty"];
    expect(pty.path).toBe("/pty/{id}");
    expect(pty.query).toEqual(["cols", "rows"]);
    expect(pty.resizePrefix).toBe(RESIZE_PREFIX);
    expect(pty.closeCodes.superseded).toBe(PTY_SUPERSEDED_CODE);
    expect(pty.closeCodes.gone).toBe(PTY_GONE_CODE);
  });

  test("an unknown session id is refused before the upgrade", async () => {
    const res = await fetch(`${s.baseUrl}/pty/no-such-session`, { headers: bearer(token) });
    expect(res.status).toBe(404);
  });

  test("the prose names the pre-upgrade 404 and the scrollback replay", () => {
    const description = loadContract()["x-shepherd-pty"].description as unknown as string;
    expect(description).toContain("404");
    expect(description).toContain("scrollback");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run test:contract
```

Expected: FAIL — `contract has no operation POST /api/sessions/{id}/reply`, plus the two
`x-shepherd-pty` prose expectations failing on the current description.

- [ ] **Step 3: Add the path inside the terminal stream block**

In `contracts/openapi.yaml`, between the `# ── stream: terminal ──` and `# ── /stream: terminal ──`
markers at the end of `paths:` (S0-prep placed the empty markers):

```yaml
  # ── stream: terminal ──
  /api/sessions/{id}/reply:
    parameters:
      - name: id
        in: path
        required: true
        schema: { type: string }
    post:
      operationId: replySession
      description: Steer a running session with operator free text. The text is delivered to the session's live agent pane. An unknown id, an unreachable herdr, or a dead pane is 404 — a normal outcome for a caller whose session list is a tick stale.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/ReplyRequest"
      responses:
        "200":
          description: The text was delivered to the agent.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Ok"
        "400":
          description: The body was not {text: string}.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Error"
        "401":
          $ref: "#/components/responses/Unauthorized"
        "404":
          description: Unknown id, or the session has no live agent pane.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Error"
        "415":
          description: Content-Type was not application/json.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Error"
  # ── /stream: terminal ──
```

- [ ] **Step 4: Add the schema inside the terminal schema block**

Between the `# ── stream: terminal ──` markers under `components.schemas:`:

```yaml
    # ── stream: terminal ──
    ReplyRequest:
      type: object
      additionalProperties: false
      required: [text]
      properties:
        text:
          type: string
          description: Operator free text, delivered verbatim to the agent pane.
    # ── /stream: terminal ──
```

- [ ] **Step 5: Sharpen the `x-shepherd-pty` prose**

Replace the `description:` line of the existing `x-shepherd-pty` block (leave `path`, `query`,
`resizePrefix` and `closeCodes` untouched — the drift test pins them):

```yaml
x-shepherd-pty:
  description: WebSocket /pty/{id}?cols=&rows=. Same auth gate and origin check as HTTP; the bearer goes on the upgrade request. An unknown session id is answered 404 before the upgrade. cols/rows set the attach size so the first paint matches the client's viewport. On attach the server replays the pane's scrollback, so a client must clear its own buffer on every (re)attach rather than appending. Server→client frames are raw terminal bytes (binary or text). Client→server text frames are keystrokes, except frames starting with resizePrefix which carry "<cols>:<rows>\n". One owner per terminal id; a new attach closes the previous socket with closeCodes.superseded and the loser must NOT reconnect (both would bump each other forever). closeCodes.gone means the session no longer has a live agent and no reattach can succeed. Any other close is transient; clients retry with backoff.
  path: /pty/{id}
  query: [cols, rows]
  resizePrefix: " resize:"
  closeCodes:
    superseded: 4000
    gone: 4001
```

- [ ] **Step 6: Run the contract suite**

```bash
bun run test:contract
```

Expected: PASS, including the whole pre-existing `test/contract/openapi.test.ts` (its coverage
assertions must still hold — the new operation is exercised by `terminal.test.ts`).

- [ ] **Step 7: Derive and sync the Swift contract**

```bash
bun run gen:contract-swift
./native/scripts/sync-contract.sh
swift build --package-path native
```

Expected: `sync-contract: contracts/openapi.swift.yaml -> native/Sources/ShepherdKit/openapi.yaml`,
then `Build complete!`.

- [ ] **Step 8: Commit**

```bash
git add contracts/openapi.yaml contracts/openapi.swift.yaml \
  native/Sources/ShepherdKit/openapi.yaml test/contract/terminal.test.ts
git commit -m "feat(contract): reply endpoint and sharper pty prose for the native terminal"
```

---

## Task 2: Kit — `PTYConnection` connect, output, input, resize

**Files:**
- Create: `native/Sources/ShepherdKit/Realtime/PTYConnection.swift`
- Create: `native/Tests/ShepherdKitTests/FakePTYServer.swift`
- Create: `native/Tests/ShepherdKitTests/PTYConnectionTests.swift`

**Interfaces:**
- Consumes: `ShepherdClient.currentToken()`, `ShepherdClient.profile.baseURL` (existing).
- Produces:
  - `public actor PTYConnection`
  - `public enum PTYConnection.Closure: Sendable, Equatable { case superseded, gone, unreachable, stopped }`
  - `public enum PTYConnection.LifecycleEvent: Sendable, Equatable { case attached, reattached, detached, closed(Closure) }`
  - `public init(baseURL: URL, sessionID: String, tokenProvider: @escaping @Sendable () -> String?, urlSession: URLSession = .shared, cols: Int = 100, rows: Int = 30, reconnectDelay: Duration = .seconds(1), maxReconnectDelay: Duration = .seconds(30))`
  - `public init(client: ShepherdClient, sessionID: String, cols: Int = 100, rows: Int = 30, urlSession: URLSession = .shared)`
  - `public static func ptyURL(for baseURL: URL, sessionID: String, cols: Int, rows: Int) -> URL`
  - `public nonisolated func output() -> AsyncStream<Data>` / `lifecycle() -> AsyncStream<LifecycleEvent>`
  - `public func start()` / `stop()` / `takeOver()` / `send(_ bytes: Data)` / `resize(cols:rows:)` / `currentSize() -> PTYSize`
  - `public struct PTYSize: Equatable, Sendable { let cols: Int; let rows: Int }`
  - Tasks 3, 5, 6, 7 use these exact names.

- [ ] **Step 1: Derive the PTY fake from the events fake**

```bash
cp native/Tests/ShepherdKitTests/FakeEventServer.swift \
   native/Tests/ShepherdKitTests/FakePTYServer.swift
```

In the copy, rename throughout: `FakeEventServer` → `FakePTYServer`, `FakeEventServerError` →
`FakePTYServerError`, the queue label `run.shepherd.kit.tests.events` →
`run.shepherd.kit.tests.pty`. Keep the whole `State` class, the `init`, the reject handling, the
`receiveLoop`, `receivedTexts()`, `upgradeHeaders()`, `connectionCount()`, `setRejectUpgrades(_:)`
and `stop()` exactly as they are — they are protocol-agnostic and already correct.

Then make these four changes:

```swift
  /// `http://127.0.0.1:<port>` — callers hand this to
  /// `PTYConnection.ptyURL(for:…)`, which appends `/pty/<id>` and swaps the
  /// scheme. Replaces FakeEventServer's `url` (which hard-coded `/events`).
  let baseURL: URL
```

```swift
    // …at the end of init, replacing the `url = URL(string: "ws://…/events")!` line:
    baseURL = URL(string: "http://127.0.0.1:\(port.rawValue)")!
```

```swift
  /// Push raw terminal bytes as a binary frame, the way herdr's bridge does.
  /// Replaces FakeEventServer's text-only `send(_ json: String)`.
  func sendBytes(_ data: Data) {
    guard let connection = state.current() else { return }
    let metadata = NWProtocolWebSocket.Metadata(opcode: .binary)
    let context = NWConnection.ContentContext(identifier: "out", metadata: [metadata])
    connection.send(
      content: data, contentContext: context, isComplete: true,
      completion: .contentProcessed { _ in })
  }

  /// Close with an APPLICATION code. `.protocolCode` cannot express 4000–4999,
  /// which is exactly the range the PTY's single-owner policy lives in — this
  /// is why the events fake could not simply be reused.
  func close(code: UInt16) {
    guard let connection = state.current() else { return }
    let metadata = NWProtocolWebSocket.Metadata(opcode: .close)
    metadata.closeCode = .applicationCode(code)
    let context = NWConnection.ContentContext(identifier: "close", metadata: [metadata])
    connection.send(
      content: nil, contentContext: context, isComplete: true,
      completion: .contentProcessed { _ in })
  }

  /// Drop the connection with no close frame — a transient network failure.
  /// Replaces `closeCurrentConnection()`.
  func dropCurrentConnection() { state.current()?.cancel() }
```

- [ ] **Step 2: Write the failing connect/IO tests**

Create `native/Tests/ShepherdKitTests/PTYConnectionTests.swift`:

```swift
import Foundation
import Testing

@testable import ShepherdKit

@Suite("PTYConnection")
struct PTYConnectionTests {
  /// Network.framework handlers run on their own queue, so tests observe them
  /// by polling rather than by awaiting a continuation nobody resumes.
  private func eventually(
    timeout: Duration = .seconds(5), _ condition: @Sendable () -> Bool
  ) async throws -> Bool {
    let deadline = ContinuousClock.now.advanced(by: timeout)
    while ContinuousClock.now < deadline {
      if condition() { return true }
      try await Task.sleep(for: .milliseconds(25))
    }
    return condition()
  }

  private final class Box<Element: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Element] = []
    func append(_ value: Element) {
      lock.lock(); defer { lock.unlock() }
      values.append(value)
    }
    func all() -> [Element] {
      lock.lock(); defer { lock.unlock() }
      return values
    }
  }

  /// Drains a stream into a lock-guarded box for the life of the test.
  private func collect<Element: Sendable>(
    _ stream: AsyncStream<Element>
  ) -> (Box<Element>, Task<Void, Never>) {
    let box = Box<Element>()
    return (box, Task { for await value in stream { box.append(value) } })
  }

  private func makeConnection(
    _ server: FakePTYServer, id: String = "sess-1", cols: Int = 120, rows: Int = 40
  ) -> PTYConnection {
    PTYConnection(
      baseURL: server.baseURL, sessionID: id, tokenProvider: { "shp_test" },
      cols: cols, rows: rows,
      reconnectDelay: .milliseconds(30), maxReconnectDelay: .milliseconds(200))
  }

  @Test("the pty URL carries the ws scheme, the id and the attach size")
  func urlShape() {
    let url = PTYConnection.ptyURL(
      for: URL(string: "https://host.example.ts.net:7330/shepherd")!,
      sessionID: "a b/c", cols: 120, rows: 40)
    #expect(
      url.absoluteString
        == "wss://host.example.ts.net:7330/shepherd/pty/a%20b%2Fc?cols=120&rows=40")
  }

  @Test("connecting sends the bearer on the upgrade and reports .attached")
  func attaches() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server)
    let (lifecycle, reader) = collect(connection.lifecycle())
    defer { reader.cancel() }

    await connection.start()
    #expect(try await eventually { server.connectionCount() == 1 })
    #expect(server.upgradeHeaders()["Authorization"] == "Bearer shp_test")
    #expect(try await eventually { lifecycle.all() == [.attached] })
    await connection.stop()
  }

  @Test("server bytes arrive on output() unchanged")
  func output() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server)
    let (bytes, reader) = collect(connection.output())
    defer { reader.cancel() }
    let payload = Data([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x68, 0x69])

    await connection.start()
    #expect(try await eventually { server.connectionCount() == 1 })
    server.sendBytes(payload)
    #expect(try await eventually { bytes.all().first == payload })
    await connection.stop()
  }

  @Test("send writes keystrokes verbatim")
  func sendsInput() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server)

    await connection.start()
    #expect(try await eventually { server.connectionCount() == 1 })
    await connection.send(Data("ls -la\r".utf8))
    #expect(try await eventually { server.receivedTexts().contains("ls -la\r") })
    await connection.stop()
  }

  @Test("resize writes the control frame the bridge parses")
  func resizes() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server)

    await connection.start()
    #expect(try await eventually { server.connectionCount() == 1 })
    await connection.resize(cols: 80, rows: 24)
    #expect(try await eventually { server.receivedTexts().contains("\u{0}resize:80:24\n") })
    await connection.stop()
  }

  @Test("a resize before the socket is open is applied to the next attach")
  func resizeBeforeAttach() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server, cols: 100, rows: 30)

    await connection.resize(cols: 90, rows: 25)
    await connection.start()
    #expect(try await eventually { server.connectionCount() == 1 })
    #expect(await connection.currentSize() == PTYSize(cols: 90, rows: 25))
    await connection.stop()
  }
}
```

- [ ] **Step 3: Run the tests and watch them fail**

```bash
swift test --package-path native --filter PTY
```

Expected: FAIL — `cannot find 'PTYConnection' in scope`.

- [ ] **Step 4: Implement `PTYConnection`**

Create `native/Sources/ShepherdKit/Realtime/PTYConnection.swift`:

```swift
import Foundation

/// One attached terminal: the `/pty/{id}` WebSocket.
///
/// Shaped like `EventStream` — bearer on the upgrade, an `AsyncStream` of
/// output, a `lifecycle()` stream, capped exponential backoff — but with the
/// PTY's own single-owner policy: a 4000 (superseded) or 4001 (gone) close is
/// terminal and must never be retried. Reconnecting after a 4000 restarts the
/// takeover war with the device that just took the terminal.
public actor PTYConnection {
  /// Why the connection stopped for good.
  public enum Closure: Sendable, Equatable {
    /// 4000: another client owns this terminal now. `takeOver()` reclaims it.
    case superseded
    /// 4001: the session has no live agent. Nothing to reattach to.
    case gone
    /// Too many attaches died instantly — herdr is down, not busy. Mirrors the
    /// fast-fail heuristic in `ui/src/lib/pty.ts`.
    case unreachable
    /// `stop()` was called.
    case stopped
  }

  /// `.reattached` is distinct from `.attached` because the server replays the
  /// scrollback on every attach: the view must clear its buffer first.
  public enum LifecycleEvent: Sendable, Equatable {
    case attached
    case reattached
    case detached
    case closed(Closure)
  }

  /// Contract `x-shepherd-pty.closeCodes` / `.resizePrefix`.
  static let supersededCode = 4000
  static let goneCode = 4001
  static let resizePrefix = "\u{0}resize:"
  /// A socket that died within this long of opening never carried a session.
  static let fastFailWindow: Duration = .seconds(4)
  /// Consecutive fast failures that mean herdr itself is gone (`MAX_FAST_FAILS`).
  static let maxFastFails = 8

  private let baseURL: URL
  private let sessionID: String
  private let tokenProvider: @Sendable () -> String?
  private let urlSession: URLSession
  private let reconnectDelay: Duration
  private let maxReconnectDelay: Duration

  private let outputContinuation: AsyncStream<Data>.Continuation
  private let lifecycleContinuation: AsyncStream<LifecycleEvent>.Continuation
  private nonisolated let outputStream: AsyncStream<Data>
  private nonisolated let lifecycleStream: AsyncStream<LifecycleEvent>

  private var task: URLSessionWebSocketTask?
  private var pump: Task<Void, Never>?
  private var stopped = true
  private var everAttached = false
  private var cols: Int
  private var rows: Int

  /// Bumped by every `connect()`. `handleClose` captures it before its backoff
  /// sleep and compares after: `task == nil` alone cannot tell this backoff
  /// window from a later one that also opened and lost a socket. Same guard
  /// `EventStream.scheduleReconnect` uses, for the same reason.
  private var connectionGeneration = 0
  private var currentReconnectDelay: Duration
  private var connectedAt: ContinuousClock.Instant?
  private var consecutiveFastFails = 0

  public init(
    baseURL: URL,
    sessionID: String,
    tokenProvider: @escaping @Sendable () -> String?,
    urlSession: URLSession = .shared,
    cols: Int = 100,
    rows: Int = 30,
    reconnectDelay: Duration = .seconds(1),
    maxReconnectDelay: Duration = .seconds(30)
  ) {
    self.baseURL = baseURL
    self.sessionID = sessionID
    self.tokenProvider = tokenProvider
    self.urlSession = urlSession
    self.cols = cols
    self.rows = rows
    self.reconnectDelay = reconnectDelay
    self.maxReconnectDelay = maxReconnectDelay
    self.currentReconnectDelay = reconnectDelay
    // Terminal output is bursty; 4096 chunks is far above what one repaint
    // produces between reads by the view.
    let (output, outputContinuation) = AsyncStream<Data>.makeStream(
      bufferingPolicy: .bufferingNewest(4096))
    outputStream = output
    self.outputContinuation = outputContinuation
    let (lifecycle, lifecycleContinuation) = AsyncStream<LifecycleEvent>.makeStream(
      bufferingPolicy: .bufferingNewest(16))
    lifecycleStream = lifecycle
    self.lifecycleContinuation = lifecycleContinuation
  }

  /// Derive the URL and the token from a live client.
  public init(
    client: ShepherdClient, sessionID: String, cols: Int = 100, rows: Int = 30,
    urlSession: URLSession = .shared
  ) {
    self.init(
      baseURL: client.profile.baseURL, sessionID: sessionID,
      tokenProvider: { client.currentToken() }, urlSession: urlSession, cols: cols, rows: rows)
  }

  /// `http(s)://host/prefix` → `ws(s)://host/prefix/pty/<id>?cols=&rows=`,
  /// preserving a reverse-proxy path prefix and percent-encoding the id.
  /// Never force-unwraps: a baseURL `URLComponents` will not round-trip falls
  /// back to string surgery rather than trapping.
  public static func ptyURL(for baseURL: URL, sessionID: String, cols: Int, rows: Int) -> URL {
    let encoded =
      sessionID.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? sessionID
    guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
      return fallbackURL(baseURL: baseURL, encodedID: encoded, cols: cols, rows: rows)
    }
    components.scheme = components.scheme == "https" ? "wss" : "ws"
    components.fragment = nil
    let path = components.path
    let prefix = path.hasSuffix("/") ? String(path.dropLast()) : path
    // percentEncodedPath, not path: `path` would re-encode the `%` of an
    // already-encoded id into `%25`.
    components.percentEncodedPath = prefix + "/pty/" + encoded
    components.queryItems = [
      URLQueryItem(name: "cols", value: String(cols)),
      URLQueryItem(name: "rows", value: String(rows)),
    ]
    guard let url = components.url else {
      return fallbackURL(baseURL: baseURL, encodedID: encoded, cols: cols, rows: rows)
    }
    return url
  }

  private static func fallbackURL(baseURL: URL, encodedID: String, cols: Int, rows: Int) -> URL {
    let appended = baseURL.appendingPathComponent("pty").appendingPathComponent(encodedID)
    var absolute = appended.absoluteString + "?cols=\(cols)&rows=\(rows)"
    if absolute.hasPrefix("https://") {
      absolute = "wss://" + absolute.dropFirst("https://".count)
    } else if absolute.hasPrefix("http://") {
      absolute = "ws://" + absolute.dropFirst("http://".count)
    }
    return URL(string: absolute) ?? appended
  }

  /// Output bytes, oldest first. Single-consumer, like `EventStream.events()`:
  /// two iterators would split the elements, not each get a copy.
  public nonisolated func output() -> AsyncStream<Data> { outputStream }
  /// Socket lifecycle, oldest first. Single-consumer for the same reason.
  public nonisolated func lifecycle() -> AsyncStream<LifecycleEvent> { lifecycleStream }
  /// The size the next attach will use.
  public func currentSize() -> PTYSize { PTYSize(cols: cols, rows: rows) }

  /// Opens the socket and keeps it open. Idempotent.
  public func start() {
    guard stopped else { return }
    stopped = false
    currentReconnectDelay = reconnectDelay
    consecutiveFastFails = 0
    connect()
  }

  /// Closes the socket and stops retrying. Does **not** finish `output()` —
  /// `start()`/`takeOver()` can reopen it — so a consumer that no longer wants
  /// bytes must cancel its own task.
  public func stop() {
    guard !stopped else { return }
    stopped = true
    pump?.cancel()
    pump = nil
    task?.cancel(with: .goingAway, reason: nil)
    task = nil
    lifecycleContinuation.yield(.closed(.stopped))
  }

  /// Re-attach after a `.superseded` (or any terminal state the operator wants
  /// to override): makes this client the owner again and resets the backoff.
  public func takeOver() {
    stopped = false
    currentReconnectDelay = reconnectDelay
    consecutiveFastFails = 0
    pump?.cancel()
    pump = nil
    task?.cancel(with: .goingAway, reason: nil)
    task = nil
    connect()
  }

  /// Keystrokes, verbatim. Dropped when there is no live socket: a terminal has
  /// no sensible queue semantics for input typed while detached.
  public func send(_ bytes: Data) {
    task?.send(.string(String(decoding: bytes, as: UTF8.self))) { _ in }
  }

  /// Remember the size (so a reconnect attaches at it) and, if a socket is
  /// live, write the control frame the bridge's demuxer parses.
  public func resize(cols: Int, rows: Int) {
    guard cols > 0, rows > 0 else { return }
    self.cols = cols
    self.rows = rows
    task?.send(.string("\(Self.resizePrefix)\(cols):\(rows)\n")) { _ in }
  }

  private func connect() {
    var request = URLRequest(
      url: Self.ptyURL(for: baseURL, sessionID: sessionID, cols: cols, rows: rows))
    // Read the token afresh: a rotated token has to reach the next upgrade.
    if let token = tokenProvider() {
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
    let socket = urlSession.webSocketTask(with: request)
    task = socket
    connectionGeneration += 1
    connectedAt = .now
    socket.resume()
    lifecycleContinuation.yield(everAttached ? .reattached : .attached)
    everAttached = true
    pump = Task { [weak self] in await self?.receiveLoop(socket) }
  }

  private func receiveLoop(_ socket: URLSessionWebSocketTask) async {
    while !Task.isCancelled {
      do {
        switch try await socket.receive() {
        case .string(let text): outputContinuation.yield(Data(text.utf8))
        case .data(let data): outputContinuation.yield(data)
        @unknown default: break
        }
      } catch {
        break  // any receive failure means the socket is gone
      }
    }
    await handleClose(of: socket)
  }

  deinit {
    outputContinuation.finish()
    lifecycleContinuation.finish()
  }
}

/// The attach dimensions of a `PTYConnection`.
public struct PTYSize: Equatable, Sendable {
  public let cols: Int
  public let rows: Int
  public init(cols: Int, rows: Int) {
    self.cols = cols
    self.rows = rows
  }
}
```

Task 3 writes `handleClose(of:)`. For this task only, add a stub at the end of the file so it
compiles and the IO tests can run — Task 3 deletes it:

```swift
extension PTYConnection {
  /// TEMPORARY (Task 2 only). Task 3 replaces this with the real close policy.
  private func handleClose(of socket: URLSessionWebSocketTask) async {
    guard !stopped, task === socket else { return }
    task = nil
    lifecycleContinuation.yield(.detached)
  }
}
```

- [ ] **Step 5: Run the tests and watch them pass**

```bash
swift test --package-path native --filter PTY
```

Expected: PASS — 6 tests. The `Authorization` assertion proves the bearer rides the upgrade;
`\u{0}resize:80:24\n` proves the control frame matches the server's `RESIZE_PREFIX`.

- [ ] **Step 6: Commit**

```bash
git add native/Sources/ShepherdKit/Realtime/PTYConnection.swift \
  native/Tests/ShepherdKitTests/FakePTYServer.swift \
  native/Tests/ShepherdKitTests/PTYConnectionTests.swift
git commit -m "feat(native): PTYConnection attach, output, input and resize"
```

---

## Task 3: Kit — close-code policy, backoff and take-over

**Files:**
- Modify: `native/Sources/ShepherdKit/Realtime/PTYConnection.swift` (replace the temporary
  `handleClose(of:)`)
- Modify: `native/Tests/ShepherdKitTests/PTYConnectionTests.swift` (append tests)

**Interfaces:**
- Consumes: everything Task 2 produced.
- Produces: the guarantee Tasks 6 and 7 rely on — `lifecycle()` emits exactly
  `.closed(.superseded)` for a 4000 close, `.closed(.gone)` for 4001,
  `.closed(.unreachable)` after 8 consecutive fast failures, and `.detached` then `.reattached`
  for anything transient.

- [ ] **Step 1: Write the failing close-policy tests**

Append to `native/Tests/ShepherdKitTests/PTYConnectionTests.swift`, inside the suite:

```swift
  @Test("close 4000 parks the connection instead of reconnecting")
  func supersededParks() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server)
    let (lifecycle, reader) = collect(connection.lifecycle())
    defer { reader.cancel() }

    await connection.start()
    #expect(try await eventually { server.connectionCount() == 1 })
    server.close(code: 4000)

    #expect(try await eventually { lifecycle.all().contains(.closed(.superseded)) })
    // The whole point: no second attach. Reconnecting here would bump the
    // device that just took over, which would bump back.
    #expect(try await eventually(timeout: .milliseconds(400)) { server.connectionCount() > 1 } == false)
    await connection.stop()
  }

  @Test("close 4001 ends the connection for good")
  func goneEnds() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server)
    let (lifecycle, reader) = collect(connection.lifecycle())
    defer { reader.cancel() }

    await connection.start()
    #expect(try await eventually { server.connectionCount() == 1 })
    server.close(code: 4001)

    #expect(try await eventually { lifecycle.all().contains(.closed(.gone)) })
    #expect(try await eventually(timeout: .milliseconds(400)) { server.connectionCount() > 1 } == false)
    await connection.stop()
  }

  @Test("takeOver re-attaches after a 4000")
  func takeOverReattaches() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server)
    let (lifecycle, reader) = collect(connection.lifecycle())
    defer { reader.cancel() }

    await connection.start()
    #expect(try await eventually { server.connectionCount() == 1 })
    server.close(code: 4000)
    #expect(try await eventually { lifecycle.all().contains(.closed(.superseded)) })

    await connection.takeOver()
    #expect(try await eventually { server.connectionCount() == 2 })
    // A second socket is a reattach, not a first attach: the view must clear
    // its buffer before the replayed scrollback lands.
    #expect(try await eventually { lifecycle.all().contains(.reattached) })
    await connection.stop()
  }

  @Test("a transient drop reconnects and reports .reattached")
  func transientReconnects() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server)
    let (lifecycle, reader) = collect(connection.lifecycle())
    defer { reader.cancel() }

    await connection.start()
    #expect(try await eventually { server.connectionCount() == 1 })
    server.dropCurrentConnection()

    #expect(try await eventually { server.connectionCount() >= 2 })
    #expect(try await eventually { lifecycle.all().contains(.detached) })
    #expect(try await eventually { lifecycle.all().contains(.reattached) })
    await connection.stop()
  }

  @Test("eight refused upgrades in a row report .unreachable and stop retrying")
  func fastFailsGiveUp() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    server.setRejectUpgrades(true)
    let connection = makeConnection(server)
    let (lifecycle, reader) = collect(connection.lifecycle())
    defer { reader.cancel() }

    await connection.start()
    #expect(try await eventually(timeout: .seconds(10)) {
      lifecycle.all().contains(.closed(.unreachable))
    })
    let attempts = server.connectionCount()
    #expect(attempts == PTYConnection.maxFastFails)
    // And it really stopped: no further attach after the verdict.
    #expect(try await eventually(timeout: .milliseconds(400)) {
      server.connectionCount() > attempts
    } == false)
    await connection.stop()
  }

  @Test("stop() reports .closed(.stopped) and opens nothing more")
  func stopIsTerminal() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server)
    let (lifecycle, reader) = collect(connection.lifecycle())
    defer { reader.cancel() }

    await connection.start()
    #expect(try await eventually { server.connectionCount() == 1 })
    await connection.stop()

    #expect(try await eventually { lifecycle.all().contains(.closed(.stopped)) })
    #expect(try await eventually(timeout: .milliseconds(400)) { server.connectionCount() > 1 } == false)
  }
```

- [ ] **Step 2: Run them and watch them fail**

```bash
swift test --package-path native --filter PTY
```

Expected: FAIL — `supersededParks`, `goneEnds`, `takeOverReattaches`, `fastFailsGiveUp` all fail
(the temporary `handleClose` yields `.detached` and never retries or classifies).

- [ ] **Step 3: Replace the temporary close handler with the real policy**

Delete the temporary `extension PTYConnection { private func handleClose… }` from Task 2 and add
these members inside the actor body, after `receiveLoop`:

```swift
  /// The peer's close code, or `nil` while the socket is still open.
  ///
  /// 4000/4001 are application codes: they have no case in
  /// `URLSessionWebSocketTask.CloseCode`, so the raw value is what carries
  /// them. `.invalid` (0) means the socket died without a close frame — a
  /// dropped network or a refused upgrade, both of which are transient as far
  /// as policy is concerned.
  private func peerCloseCode(of socket: URLSessionWebSocketTask) -> Int {
    socket.closeCode.rawValue
  }

  private func handleClose(of socket: URLSessionWebSocketTask) async {
    // A pump left running after `stop()`/`takeOver()` already replaced this
    // socket must not report anything: the replacement owns the lifecycle now.
    guard !stopped, task === socket else { return }
    let capturedGeneration = connectionGeneration
    let code = peerCloseCode(of: socket)
    task = nil

    // The two single-owner codes are terminal by contract. Reconnecting after
    // 4000 restarts the takeover war; after 4001 it loops on agent_not_found.
    if code == Self.supersededCode {
      stopped = true
      lifecycleContinuation.yield(.closed(.superseded))
      return
    }
    if code == Self.goneCode {
      stopped = true
      lifecycleContinuation.yield(.closed(.gone))
      return
    }

    // A socket that lived past the window carried a real session; anything
    // shorter is an attach against a herdr that is not there.
    let lived = connectedAt.map { ContinuousClock.now - $0 } ?? .zero
    if lived >= Self.fastFailWindow {
      consecutiveFastFails = 0
      currentReconnectDelay = reconnectDelay
    } else {
      consecutiveFastFails += 1
    }
    if consecutiveFastFails >= Self.maxFastFails {
      stopped = true
      ShepherdLog.realtime.notice(
        "pty gave up after \(Self.maxFastFails, privacy: .public) immediate failures")
      lifecycleContinuation.yield(.closed(.unreachable))
      return
    }

    lifecycleContinuation.yield(.detached)
    let delay = currentReconnectDelay
    currentReconnectDelay = min(currentReconnectDelay * 2, maxReconnectDelay)
    do {
      try await Task.sleep(for: delay)
    } catch {
      return  // cancelled while waiting
    }
    // `task == nil` plus the generation check is the same guard EventStream
    // uses: `task == nil` alone cannot tell this backoff window from a later
    // one that also opened and lost a socket while this continuation was
    // queued.
    guard !stopped, task == nil, connectionGeneration == capturedGeneration else { return }
    connect()
  }
```

**Contingency (only if `supersededParks` fails with `.detached` instead of
`.closed(.superseded)`):** `closeCode.rawValue` is not surfacing the application code on this
toolchain. Replace `peerCloseCode(of:)` with a delegate capture — add to the file:

```swift
/// Captures the peer's close code, for platforms where
/// `URLSessionWebSocketTask.closeCode` does not surface application codes.
final class PTYCloseCodeRecorder: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
  private let lock = NSLock()
  private var code: Int?
  func take() -> Int? {
    lock.lock(); defer { lock.unlock() }
    let value = code
    code = nil
    return value
  }
  func urlSession(
    _ session: URLSession, webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?
  ) {
    lock.lock(); defer { lock.unlock() }
    code = closeCode.rawValue
  }
}
```

…construct the actor's session as
`URLSession(configuration: .default, delegate: recorder, delegateQueue: nil)` when the caller passes
no session, and read `recorder.take() ?? 0` in `peerCloseCode(of:)`. The tests do not change.

- [ ] **Step 4: Run the tests and watch them pass**

```bash
swift test --package-path native --filter PTY
```

Expected: PASS — 12 tests in `PTYConnection`.

- [ ] **Step 5: Run the whole kit suite for regressions**

```bash
swift test --package-path native
```

Expected: PASS — no `/events` or store test may have moved.

- [ ] **Step 6: Commit**

```bash
git add native/Sources/ShepherdKit/Realtime/PTYConnection.swift \
  native/Tests/ShepherdKitTests/PTYConnectionTests.swift
git commit -m "feat(native): pty close-code policy, capped backoff and take-over"
```

---

## Task 4: Kit — `replySession` over the generated client

**Files:**
- Create: `native/Sources/ShepherdKit/Client/ShepherdClient+Terminal.swift`
- Create: `native/Tests/ShepherdKitTests/ShepherdClientTerminalTests.swift`

**Interfaces:**
- Consumes: the generated `replySession` operation from Task 1; `ShepherdError` (existing).
- Produces: `public func replySession(id: String, text: String) async throws` on `ShepherdClient`.
  Task 6 calls exactly this.

- [ ] **Step 1: Write the failing tests**

Create `native/Tests/ShepherdKitTests/ShepherdClientTerminalTests.swift`:

```swift
import Foundation
import Testing

@testable import ShepherdKit

@Suite("ShepherdClient terminal")
struct ShepherdClientTerminalTests {
  private func makeClient(_ server: FakeShepherdServer) throws -> ShepherdClient {
    let credentials = InMemoryCredentialStore(
      seed: ["k": StoredCredential(token: "shp_test", tokenId: "tok")])
    let profile = ServerProfile(
      name: "fake", baseURL: server.baseURL, mode: .local, credentialKey: "k")
    return try ShepherdClient(
      profile: profile, credentials: credentials, urlSession: server.urlSession())
  }

  @Test("200 returns without throwing")
  func delivered() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/reply", status: 200, json: Data(#"{"ok":true}"#.utf8))
    let client = try makeClient(server)

    try await client.replySession(id: "s1", text: "go ahead")
  }

  @Test("the body is the contract's ReplyRequest")
  func sendsBody() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/reply", status: 200, json: Data(#"{"ok":true}"#.utf8))
    let client = try makeClient(server)

    try await client.replySession(id: "s1", text: "ship it")

    let body = try #require(server.requests().last?.body)
    let decoded = try JSONDecoder().decode([String: String].self, from: body)
    #expect(decoded == ["text": "ship it"])
  }

  @Test("404 is notFound — a stale session list is a normal caller mistake")
  func notFound() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/reply", status: 404,
      json: Data(#"{"error":"not found"}"#.utf8))
    let client = try makeClient(server)

    await #expect(throws: ShepherdError.notFound) {
      try await client.replySession(id: "s1", text: "hi")
    }
  }

  @Test("401 is unauthenticated")
  func unauthorized() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/reply", status: 401,
      json: Data(#"{"error":"unauthorized"}"#.utf8))
    let client = try makeClient(server)

    await #expect(throws: ShepherdError.unauthenticated) {
      try await client.replySession(id: "s1", text: "hi")
    }
  }

  @Test("400 carries the server's message")
  func badRequest() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/reply", status: 400,
      json: Data(#"{"error":"body must be {text: string}"}"#.utf8))
    let client = try makeClient(server)

    await #expect(throws: ShepherdError.badRequest("body must be {text: string}")) {
      try await client.replySession(id: "s1", text: "")
    }
  }
}
```

- [ ] **Step 2: Run them and watch them fail**

```bash
swift test --package-path native --filter Terminal
```

Expected: FAIL — `value of type 'ShepherdClient' has no member 'replySession'`.

- [ ] **Step 3: Implement the extension**

Create `native/Sources/ShepherdKit/Client/ShepherdClient+Terminal.swift`:

```swift
import Foundation
import OpenAPIRuntime

extension ShepherdClient {
  /// `POST /api/sessions/{id}/reply` — steer a running session with operator
  /// free text.
  ///
  /// 404 is a normal outcome, not a bug: the server answers it for an unknown
  /// id *and* for a session whose agent pane has since died, and a caller's
  /// session list is always a tick stale. Surface it as "the agent is no longer
  /// listening", never as a crash.
  ///
  /// Never log `text`: it is operator prose and may carry anything.
  public func replySession(id: String, text: String) async throws {
    do {
      switch try await generated.replySession(
        .init(path: .init(id: id), body: .json(.init(text: text)))
      ) {
      case .ok: return
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .unsupportedMediaType:
        // The generated client always sends application/json, so this is
        // unreachable in practice — map it rather than crash if it ever is not.
        throw ShepherdError.badRequest("Content-Type must be application/json")
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "replySession")
      }
    } catch { throw ShepherdError.from(error, route: "replySession") }
  }
}
```

`generated` is `private` on `ShepherdClient`. Change its declaration in
`native/Sources/ShepherdKit/Client/ShepherdClient.swift` from `private let generated: Client` to
`internal let generated: Client` — **this is the one line this stream changes in that file**; it is
additive, non-behavioural, and cannot conflict with another stream's extension, which needs the same
access.

- [ ] **Step 4: Run the tests and watch them pass**

```bash
swift test --package-path native --filter Terminal
```

Expected: PASS — 5 tests in `ShepherdClient terminal`.

- [ ] **Step 5: Commit**

```bash
git add native/Sources/ShepherdKit/Client/ShepherdClient+Terminal.swift \
  native/Sources/ShepherdKit/Client/ShepherdClient.swift \
  native/Tests/ShepherdKitTests/ShepherdClientTerminalTests.swift
git commit -m "feat(native): shepherdclient replySession for the terminal prompt bar"
```

---

## Task 5: App — SwiftTerm dependency and the terminal copy catalog

**Files:**
- Modify: `native/Apps/ShepherdMac/project.yml` (`packages:` + the Shepherd target's `dependencies:`)
- Modify: `ui/messages/en.json`, `ui/messages/de.json` (append)
- Modify: `native/scripts/gen-strings.ts` (`KEYS_TERMINAL` only)
- Regenerate: `native/Apps/ShepherdMac/Resources/Localizable.xcstrings`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `import SwiftTerm` compiles in the Shepherd target; the ten catalog keys
  `native_terminal_*` listed below resolve through `L.t()`. Tasks 6 and 7 use exactly these keys.

- [ ] **Step 1: Add the package and the dependency**

In `native/Apps/ShepherdMac/project.yml`, extend `packages:` (keep the existing `ShepherdKit`
entry untouched):

```yaml
packages:
  # The key must match the package's own name in native/Package.swift
  # (`Package(name: "ShepherdKit", …)`), and the path is the package root.
  ShepherdKit:
    path: ../..
  # Pinned exactly, not by range: a terminal emulator's rendering and delegate
  # surface must not float under CI. 1.20.0 is the newest 1.x tag on the repo.
  SwiftTerm:
    url: https://github.com/migueldeicaza/SwiftTerm
    exactVersion: 1.20.0
```

and the Shepherd target's `dependencies:`:

```yaml
    dependencies:
      - package: ShepherdKit
        product: ShepherdKit
      - package: SwiftTerm
        product: SwiftTerm
```

- [ ] **Step 2: Prove the dependency resolves and links**

```bash
./native/scripts/build-app.sh
```

Expected: `** BUILD SUCCEEDED **`, with `Resolved source packages: SwiftTerm 1.20.0` (or a
`Fetching` line for it) earlier in the log. If XcodeGen reports an unknown key, the installed
version predates `exactVersion`; `brew upgrade xcodegen` and retry.

- [ ] **Step 3: Append the EN keys**

Append to `ui/messages/en.json` (before the closing brace; the union merge driver makes tail
insertions conflict-free):

```json
  "native_terminal_connecting": "Connecting to the agent…",
  "native_terminal_ended_body": "This session no longer has a running agent. Its output is frozen.",
  "native_terminal_ended_title": "Session ended",
  "native_terminal_prompt_failed": "The agent did not take the message.",
  "native_terminal_prompt_placeholder": "Send a message to the agent",
  "native_terminal_prompt_send": "Send",
  "native_terminal_superseded_action": "Take over",
  "native_terminal_superseded_body": "Another device attached to this terminal. Taking over hands it back to this Mac and detaches the other one.",
  "native_terminal_superseded_title": "Another device has this terminal",
  "native_terminal_tab_title": "Terminal",
  "native_terminal_unreachable_body": "The agent runner is not answering. Check that the Shepherd server and herdr are running.",
  "native_terminal_unreachable_title": "Cannot reach the agent"
```

- [ ] **Step 4: Append the DE keys**

Append to `ui/messages/de.json`:

```json
  "native_terminal_connecting": "Verbinde mit dem Agenten…",
  "native_terminal_ended_body": "Diese Sitzung hat keinen laufenden Agenten mehr. Die Ausgabe ist eingefroren.",
  "native_terminal_ended_title": "Sitzung beendet",
  "native_terminal_prompt_failed": "Der Agent hat die Nachricht nicht angenommen.",
  "native_terminal_prompt_placeholder": "Nachricht an den Agenten",
  "native_terminal_prompt_send": "Senden",
  "native_terminal_superseded_action": "Übernehmen",
  "native_terminal_superseded_body": "Ein anderes Gerät ist mit diesem Terminal verbunden. Beim Übernehmen wechselt es zurück auf diesen Mac und das andere Gerät wird getrennt.",
  "native_terminal_superseded_title": "Ein anderes Gerät hat dieses Terminal",
  "native_terminal_tab_title": "Terminal",
  "native_terminal_unreachable_body": "Der Agent-Runner antwortet nicht. Prüfe, ob der Shepherd-Server und herdr laufen.",
  "native_terminal_unreachable_title": "Agent nicht erreichbar"
```

- [ ] **Step 5: Fill `KEYS_TERMINAL`**

In `native/scripts/gen-strings.ts`, replace the empty `KEYS_TERMINAL` array S0-prep added (edit
**only** this array):

```ts
/** Terminal stream (S1). Keep alphabetical. */
export const KEYS_TERMINAL: readonly string[] = [
  "native_terminal_connecting",
  "native_terminal_ended_body",
  "native_terminal_ended_title",
  "native_terminal_prompt_failed",
  "native_terminal_prompt_placeholder",
  "native_terminal_prompt_send",
  "native_terminal_superseded_action",
  "native_terminal_superseded_body",
  "native_terminal_superseded_title",
  "native_terminal_tab_title",
  "native_terminal_unreachable_body",
  "native_terminal_unreachable_title",
];
```

- [ ] **Step 6: Regenerate the String Catalog and check both gates**

```bash
bun native/scripts/gen-strings.ts
bun run check:strings
(cd ui && bun run check:i18n)
```

Expected: `Wrote …/Localizable.xcstrings (<N> keys, en + de).`, then
`Localizable.xcstrings is up to date (<N> keys).`, then the i18n gate passing (identical key sets in
EN and DE).

- [ ] **Step 7: Commit**

```bash
git add native/Apps/ShepherdMac/project.yml native/scripts/gen-strings.ts \
  native/Apps/ShepherdMac/Resources/Localizable.xcstrings \
  ui/messages/en.json ui/messages/de.json
git commit -m "feat(native): swiftterm 1.20.0 dependency and terminal copy catalog"
```

---

## Task 6: App — `TerminalSessionModel` state machine

**Files:**
- Create: `native/Apps/ShepherdMac/Sources/Terminal/PTYAttaching.swift`
- Create: `native/Apps/ShepherdMac/Sources/Terminal/TerminalSessionModel.swift`
- Create: `native/Apps/ShepherdMac/Tests/TerminalStateTests.swift`

**Interfaces:**
- Consumes: `PTYConnection.LifecycleEvent` / `.Closure` (Task 3);
  `ShepherdClient.replySession(id:text:)` (Task 4); the `native_terminal_*` keys (Task 5).
- Produces:
  - `@MainActor protocol PTYAttaching: AnyObject` — `start()`, `stop()`, `takeOver()`, `send(_:)`,
    `resize(cols:rows:)`, `var output: AsyncStream<Data>`,
    `var lifecycle: AsyncStream<PTYConnection.LifecycleEvent>`
  - `final class LivePTYAttachment: PTYAttaching`
  - `@Observable @MainActor final class TerminalSessionModel` with
    `enum Phase { case idle, connecting, live, superseded, ended(PTYConnection.Closure) }`,
    `phase`, `promptText`, `promptBusy`, `promptError`, `onOutput`, `onClear`, `sessionID`,
    `attach(cols:rows:)`, `detach()`, `takeOver()`, `send(_:)`, `resize(cols:rows:)`,
    `submitPrompt()`, and `init(sessionID:store:)`.
  - Task 7 renders exactly these.

- [ ] **Step 1: Write the failing state tests**

Create `native/Apps/ShepherdMac/Tests/TerminalStateTests.swift`:

```swift
import Foundation
import Testing
import ShepherdKit

@testable import Shepherd

/// Yields until `condition` holds or the budget runs out. Mirrors
/// `AppModelTests.settle`: everything here is main-actor work a yield lets run.
@MainActor
private func settle(until condition: () -> Bool, yields: Int = 500) async -> Bool {
    for _ in 0..<yields {
        if condition() { return true }
        await Task.yield()
    }
    return condition()
}

/// Main-actor recorders the test closures write into. `@MainActor` makes them
/// implicitly `Sendable`, so a `@Sendable` reply closure may capture them.
@MainActor
final class Recorder {
    private var chunks: [Data] = []
    func append(_ data: Data) { chunks.append(data) }
    func joined() -> String { String(decoding: chunks.reduce(Data(), +), as: UTF8.self) }
}

@MainActor
final class Counter {
    private(set) var value = 0
    func bump() { value += 1 }
}

/// A hand-driven stand-in for a live `PTYConnection`.
@MainActor
final class FakeAttachment: PTYAttaching {
    private(set) var startCount = 0
    private(set) var stopCount = 0
    private(set) var takeOverCount = 0
    private(set) var sent: [Data] = []
    private(set) var sizes: [(cols: Int, rows: Int)] = []

    private let outputContinuation: AsyncStream<Data>.Continuation
    private let lifecycleContinuation: AsyncStream<PTYConnection.LifecycleEvent>.Continuation
    let output: AsyncStream<Data>
    let lifecycle: AsyncStream<PTYConnection.LifecycleEvent>

    init() {
        (output, outputContinuation) = AsyncStream<Data>.makeStream()
        (lifecycle, lifecycleContinuation) = AsyncStream<PTYConnection.LifecycleEvent>.makeStream()
    }

    func start() { startCount += 1 }
    func stop() { stopCount += 1 }
    func takeOver() { takeOverCount += 1 }
    func send(_ bytes: Data) { sent.append(bytes) }
    func resize(cols: Int, rows: Int) { sizes.append((cols, rows)) }

    func emit(_ event: PTYConnection.LifecycleEvent) { lifecycleContinuation.yield(event) }
    func emit(bytes: Data) { outputContinuation.yield(bytes) }
}

@MainActor
struct TerminalStateTests {
    private func makeModel(
        _ attachment: FakeAttachment,
        reply: @escaping @Sendable (String) async throws -> Void = { _ in }
    ) -> TerminalSessionModel {
        TerminalSessionModel(
            sessionID: "s1", reply: reply, makeAttachment: { _, _ in attachment })
    }

    @Test func startsIdle() {
        let model = makeModel(FakeAttachment())
        #expect(model.phase == .idle)
        #expect(model.promptBusy == false)
    }

    @Test func attachingConnectsAndGoesLive() async {
        let attachment = FakeAttachment()
        let model = makeModel(attachment)

        model.attach(cols: 120, rows: 40)
        #expect(model.phase == .connecting)
        #expect(attachment.startCount == 1)

        attachment.emit(.attached)
        #expect(await settle(until: { model.phase == .live }))
    }

    @Test func outputReachesTheViewAfterItSubscribes() async {
        let attachment = FakeAttachment()
        let model = makeModel(attachment)
        model.attach(cols: 80, rows: 24)
        attachment.emit(.attached)
        #expect(await settle(until: { model.phase == .live }))

        // Bytes that land before the view exists must not be lost: the first
        // paint of a session IS the replayed scrollback.
        attachment.emit(bytes: Data("early".utf8))
        let seen = Recorder()
        model.onOutput = { seen.append($0) }
        #expect(await settle(until: { seen.joined() == "early" }))

        attachment.emit(bytes: Data("later".utf8))
        #expect(await settle(until: { seen.joined() == "earlylater" }))
    }

    @Test func reattachClearsTheBufferAndReSendsTheSize() async {
        let attachment = FakeAttachment()
        let model = makeModel(attachment)
        let cleared = Counter()
        model.onClear = { cleared.bump() }
        model.attach(cols: 80, rows: 24)

        attachment.emit(.attached)
        #expect(await settle(until: { model.phase == .live }))
        attachment.emit(.detached)
        #expect(await settle(until: { model.phase == .connecting }))
        attachment.emit(.reattached)

        // The server replays the scrollback on every attach; appending instead
        // of clearing would double every line.
        #expect(await settle(until: { cleared.value == 1 && model.phase == .live }))
        #expect(await settle(until: { attachment.sizes.last?.cols == 80 }))
    }

    @Test func supersededParksAndTakeOverReattaches() async {
        let attachment = FakeAttachment()
        let model = makeModel(attachment)
        model.attach(cols: 80, rows: 24)
        attachment.emit(.attached)
        #expect(await settle(until: { model.phase == .live }))

        attachment.emit(.closed(.superseded))
        #expect(await settle(until: { model.phase == .superseded }))

        model.takeOver()
        #expect(attachment.takeOverCount == 1)
        #expect(model.phase == .connecting)
    }

    @Test func goneAndUnreachableEndTheSession() async {
        let goneAttachment = FakeAttachment()
        let gone = makeModel(goneAttachment)
        gone.attach(cols: 80, rows: 24)
        goneAttachment.emit(.closed(.gone))
        #expect(await settle(until: { gone.phase == .ended(.gone) }))

        let deadAttachment = FakeAttachment()
        let dead = makeModel(deadAttachment)
        dead.attach(cols: 80, rows: 24)
        deadAttachment.emit(.closed(.unreachable))
        #expect(await settle(until: { dead.phase == .ended(.unreachable) }))
    }

    @Test func promptIsBusyWhileTheReplyIsInFlight() async {
        let gate = Gate()
        let model = makeModel(FakeAttachment(), reply: { _ in await gate.wait() })
        model.promptText = "go ahead"

        let submitted = Task { await model.submitPrompt() }
        #expect(await settle(until: { gate.isWaiting }))
        #expect(model.promptBusy)
        // The field clears optimistically so the operator can keep typing.
        #expect(model.promptText.isEmpty)

        gate.open()
        _ = await submitted.value
        #expect(model.promptBusy == false)
        #expect(model.promptError == nil)
    }

    @Test func aFailedReplyRestoresTheTextAndShowsWhy() async {
        let model = makeModel(FakeAttachment(), reply: { _ in throw ShepherdError.notFound })
        model.promptText = "go ahead"

        await model.submitPrompt()

        #expect(model.promptBusy == false)
        #expect(model.promptText == "go ahead")
        #expect(model.promptError == L.t("native_terminal_prompt_failed"))
    }

    @Test func blankPromptsAreNotSent() async {
        let sentBox = Counter()
        // `reply` is nonisolated and `@Sendable`; `Counter` is `@MainActor`,
        // so the hop is explicit.
        let model = makeModel(FakeAttachment(), reply: { _ in await sentBox.bump() })
        model.promptText = "   \n "

        await model.submitPrompt()

        #expect(sentBox.value == 0)
        #expect(model.promptBusy == false)
    }

    @Test func detachAfterASubmitDiscardsTheStaleCompletion() async {
        let gate = Gate()
        let model = makeModel(FakeAttachment(), reply: { _ in
            await gate.wait()
            throw ShepherdError.notFound
        })
        model.promptText = "go ahead"

        let submitted = Task { await model.submitPrompt() }
        #expect(await settle(until: { gate.isWaiting }))
        // The operator switched away and came back: detach + attach bump the
        // generation the in-flight reply captured.
        model.detach()
        model.attach(cols: 80, rows: 24)
        gate.open()
        _ = await submitted.value

        // The stale failure must not paint an error over the fresh attach.
        #expect(model.promptError == nil)
        #expect(model.promptBusy == false)
    }
}
```

- [ ] **Step 2: Run them and watch them fail**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests
```

Expected: FAIL — `cannot find type 'PTYAttaching' in scope`.

- [ ] **Step 3: Write the attachment seam**

Create `native/Apps/ShepherdMac/Sources/Terminal/PTYAttaching.swift`:

```swift
import Foundation
import ShepherdKit

/// The terminal's view of a PTY socket, with every actor hop already taken.
///
/// `TerminalSessionModel` is a main-actor state machine; making it `await` the
/// actor directly would put a suspension in front of every transition and make
/// the unit tests race. This protocol is the seam: `LivePTYAttachment` wraps the
/// real `PTYConnection`, the tests substitute a hand-driven fake.
@MainActor
protocol PTYAttaching: AnyObject {
    func start()
    func stop()
    func takeOver()
    func send(_ bytes: Data)
    func resize(cols: Int, rows: Int)
    var output: AsyncStream<Data> { get }
    var lifecycle: AsyncStream<PTYConnection.LifecycleEvent> { get }
}

@MainActor
final class LivePTYAttachment: PTYAttaching {
    private let connection: PTYConnection
    let output: AsyncStream<Data>
    let lifecycle: AsyncStream<PTYConnection.LifecycleEvent>

    init(client: ShepherdClient, sessionID: String, cols: Int, rows: Int) {
        let connection = PTYConnection(
            client: client, sessionID: sessionID, cols: cols, rows: rows)
        self.connection = connection
        // Taken once, here: both streams are single-consumer, so a second call
        // would split the elements between two iterators instead of copying.
        output = connection.output()
        lifecycle = connection.lifecycle()
    }

    func start() { Task { [connection] in await connection.start() } }
    func stop() { Task { [connection] in await connection.stop() } }
    func takeOver() { Task { [connection] in await connection.takeOver() } }
    func send(_ bytes: Data) { Task { [connection] in await connection.send(bytes) } }
    func resize(cols: Int, rows: Int) {
        Task { [connection] in await connection.resize(cols: cols, rows: rows) }
    }
}
```

- [ ] **Step 4: Write the state machine**

Create `native/Apps/ShepherdMac/Sources/Terminal/TerminalSessionModel.swift`:

```swift
import Foundation
import Observation
import ShepherdKit

/// One attached terminal's UI state: owns the socket, fans output out to the
/// SwiftTerm view, and runs the prompt bar's `/reply` call.
///
/// Every async completion re-checks `generation`, which `attach`/`detach` bump.
/// A reply that resolves after the operator switched sessions (or the store was
/// torn down) must not paint an error over the fresh attach.
@Observable
@MainActor
final class TerminalSessionModel {
    /// `.ended` is terminal; `.superseded` is recoverable via `takeOver()`.
    enum Phase: Equatable {
        case idle
        case connecting
        case live
        case superseded
        case ended(PTYConnection.Closure)
    }

    private(set) var phase: Phase = .idle
    /// The prompt bar's text, two-way bound by the view.
    var promptText: String = ""
    private(set) var promptBusy = false
    private(set) var promptError: String?

    /// Set by the SwiftTerm view: raw bytes to feed the emulator. Anything that
    /// arrives before it is set is buffered, because the first bytes of an
    /// attach are the replayed scrollback.
    ///
    /// Explicitly `@MainActor` in the closure type: the view that assigns it is
    /// main-actor isolated, and a bare `((Data) -> Void)?` would need a
    /// non-isolated conversion that Swift 6 rejects at the assignment.
    var onOutput: (@MainActor (Data) -> Void)? {
        didSet {
            guard onOutput != nil, !pendingOutput.isEmpty else { return }
            let buffered = pendingOutput
            pendingOutput = []
            for chunk in buffered { onOutput?(chunk) }
        }
    }
    /// Set by the SwiftTerm view: wipe the emulator's buffer. Called on every
    /// reattach, because the server replays the scrollback and appending would
    /// double every line.
    var onClear: (@MainActor () -> Void)?

    let sessionID: String

    private let reply: @Sendable (String) async throws -> Void
    private let makeAttachment: @MainActor (Int, Int) -> any PTYAttaching
    private var attachment: (any PTYAttaching)?
    private var pumps: [Task<Void, Never>] = []
    private var pendingOutput: [Data] = []
    private var cols = 100
    private var rows = 30
    private var generation = 0

    init(
        sessionID: String,
        reply: @escaping @Sendable (String) async throws -> Void,
        makeAttachment: @escaping @MainActor (Int, Int) -> any PTYAttaching
    ) {
        self.sessionID = sessionID
        self.reply = reply
        self.makeAttachment = makeAttachment
    }

    /// The app's wiring: reply through the store's client, attach over a real
    /// socket.
    convenience init(sessionID: String, store: SessionStore) {
        let client = store.client
        self.init(
            sessionID: sessionID,
            reply: { text in try await client.replySession(id: sessionID, text: text) },
            makeAttachment: { cols, rows in
                LivePTYAttachment(client: client, sessionID: sessionID, cols: cols, rows: rows)
            })
    }

    /// Open the socket at the view's current size. Idempotent while attached: a
    /// second call only updates the size.
    func attach(cols: Int, rows: Int) {
        self.cols = max(cols, 1)
        self.rows = max(rows, 1)
        if let attachment {
            attachment.resize(cols: self.cols, rows: self.rows)
            return
        }
        generation += 1
        let generation = self.generation
        let attachment = makeAttachment(self.cols, self.rows)
        self.attachment = attachment
        phase = .connecting
        pumps = [
            Task { [weak self] in
                for await bytes in attachment.output {
                    guard let self, self.generation == generation else { return }
                    self.deliver(bytes)
                }
            },
            Task { [weak self] in
                for await event in attachment.lifecycle {
                    guard let self, self.generation == generation else { return }
                    self.apply(event)
                }
            },
        ]
        attachment.start()
    }

    /// Close the socket and drop the pumps. Bumps the generation, so anything
    /// still in flight is discarded when it lands.
    func detach() {
        generation += 1
        for pump in pumps { pump.cancel() }
        pumps = []
        attachment?.stop()
        attachment = nil
        pendingOutput = []
        phase = .idle
    }

    /// Re-attach after a takeover. Keeps the same attachment, so the existing
    /// pumps stay valid.
    func takeOver() {
        guard let attachment else { return }
        phase = .connecting
        attachment.takeOver()
    }

    func send(_ bytes: Data) { attachment?.send(bytes) }

    func resize(cols: Int, rows: Int) {
        guard cols > 0, rows > 0 else { return }
        self.cols = cols
        self.rows = rows
        attachment?.resize(cols: cols, rows: rows)
    }

    /// Send the prompt bar's text through `/reply`.
    ///
    /// The field clears optimistically so the operator can keep typing, and is
    /// restored verbatim on failure — retyping a paragraph because the agent's
    /// pane had just died is the worst outcome available here.
    func submitPrompt() async {
        let text = promptText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !promptBusy else { return }
        let generation = self.generation
        promptBusy = true
        promptError = nil
        promptText = ""
        do {
            try await reply(text)
            guard self.generation == generation else { return }
            promptBusy = false
        } catch {
            guard self.generation == generation else { return }
            promptBusy = false
            promptText = text
            promptError = L.t("native_terminal_prompt_failed")
        }
    }

    private func deliver(_ bytes: Data) {
        guard let onOutput else {
            pendingOutput.append(bytes)
            return
        }
        onOutput(bytes)
    }

    private func apply(_ event: PTYConnection.LifecycleEvent) {
        switch event {
        case .attached:
            phase = .live
        case .reattached:
            // The scrollback is replayed on every attach: clear before it lands.
            pendingOutput = []
            onClear?()
            phase = .live
            attachment?.resize(cols: cols, rows: rows)
        case .detached:
            phase = .connecting
        case .closed(.superseded):
            phase = .superseded
        case .closed(.stopped):
            phase = .idle
        case .closed(let closure):
            phase = .ended(closure)
        }
    }
}
```

- [ ] **Step 5: Run the tests and watch them pass**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests
```

Expected: PASS — 10 tests in `TerminalStateTests`, and every pre-existing `ShepherdTests` test
still green.

- [ ] **Step 6: Commit**

```bash
git add native/Apps/ShepherdMac/Sources/Terminal/PTYAttaching.swift \
  native/Apps/ShepherdMac/Sources/Terminal/TerminalSessionModel.swift \
  native/Apps/ShepherdMac/Tests/TerminalStateTests.swift
git commit -m "feat(native): terminal session state machine with pty attachment seam"
```

---

## Task 7: App — SwiftTerm view, prompt bar, takeover banner, detail tab

**Files:**
- Create: `native/Apps/ShepherdMac/Sources/Terminal/TerminalHostView.swift`
- Create: `native/Apps/ShepherdMac/Sources/Terminal/TerminalPane.swift`
- Create: `native/Apps/ShepherdMac/Sources/Terminal/TerminalController.swift`
- Create: `native/Apps/ShepherdMac/Sources/Terminal/TerminalTab.swift`
- Modify: `native/Apps/ShepherdMac/Tests/TerminalStateTests.swift` (append the registration test)

**Interfaces:**
- Consumes: `TerminalSessionModel` (Task 6); the S0-prep seams `DetailTab`, `DetailTabRegistry`,
  `AppExtension`, `AppModel.register(_:)` / `AppModel.extension(_:)`.
- Produces: `TerminalController: AppExtension`, `TerminalTab: DetailTab` (id `"terminal"`,
  order `0`), `enum TerminalInstall { static func install() }`. Task 8 hands `TerminalInstall`
  to the integration lane.

- [ ] **Step 1: Write the failing registration test**

Append to `native/Apps/ShepherdMac/Tests/TerminalStateTests.swift`:

```swift
@MainActor
struct TerminalRegistrationTests {
    private func makeApp() -> AppModel {
        let name = UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
    }

    @Test func theTerminalTabSortsAheadOfTheBuiltInPromptTab() {
        DetailTabRegistry.reset()
        TerminalInstall.install(into: makeApp())

        // order 0 is the whole point: the terminal is what the operator came for.
        #expect(DetailTabRegistry.tabs.first?.id == "terminal")
        #expect(DetailTabRegistry.tabs.first?.title == L.t("native_terminal_tab_title"))
        #expect(DetailTabRegistry.tabs.map(\.id) == ["terminal", "prompt"])
    }

    @Test func installIsIdempotent() {
        DetailTabRegistry.reset()
        let app = makeApp()
        TerminalInstall.install(into: app)
        TerminalInstall.install(into: app)

        #expect(DetailTabRegistry.tabs.filter { $0.id == "terminal" }.count == 1)
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests
```

Expected: FAIL — `cannot find 'TerminalInstall' in scope`.

- [ ] **Step 3: Write the SwiftTerm bridge**

Create `native/Apps/ShepherdMac/Sources/Terminal/TerminalHostView.swift`:

```swift
import AppKit
import SwiftTerm
import SwiftUI

/// SwiftTerm's AppKit `TerminalView`, bound to a `TerminalSessionModel`.
///
/// Data flows both ways through the coordinator: SwiftTerm hands keystrokes to
/// `send(source:data:)`, and the model hands server bytes back through
/// `onOutput`. SwiftTerm computes cols/rows from its own bounds and reports
/// them via `sizeChanged`, which is what drives the resize control frame — the
/// view is the authority on size, never the model.
struct TerminalHostView: NSViewRepresentable {
    let model: TerminalSessionModel

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    func makeNSView(context: Context) -> SwiftTerm.TerminalView {
        let view = SwiftTerm.TerminalView(frame: .init(x: 0, y: 0, width: 640, height: 400))
        view.terminalDelegate = context.coordinator
        view.font = Self.monospacedFont()
        // Claude Code turns mouse tracking on, which swallows drag-selection.
        // Option-drag is the standard escape hatch and must keep working.
        view.optionAsMetaKey = false
        context.coordinator.bind(view)
        return view
    }

    func updateNSView(_ view: SwiftTerm.TerminalView, context: Context) {
        context.coordinator.bind(view)
        // Follow the app appearance: a light-mode window with a black terminal
        // reads as broken, not as a theme.
        let dark = view.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        view.nativeBackgroundColor = dark ? .textBackgroundColor : .textBackgroundColor
        view.nativeForegroundColor = .textColor
    }

    /// JetBrains Mono when the operator has it installed, otherwise the system
    /// monospace face. Never a hard-coded fallback name that may not exist.
    static func monospacedFont(size: CGFloat = 12) -> NSFont {
        NSFont(name: "JetBrains Mono", size: size)
            ?? NSFont.monospacedSystemFont(ofSize: size, weight: .regular)
    }

    @MainActor
    final class Coordinator: NSObject, TerminalViewDelegate {
        private let model: TerminalSessionModel
        private weak var view: SwiftTerm.TerminalView?

        init(model: TerminalSessionModel) {
            self.model = model
            super.init()
        }

        /// Idempotent: `updateNSView` runs on every SwiftUI pass, and re-binding
        /// the same view must not stack duplicate output closures.
        func bind(_ view: SwiftTerm.TerminalView) {
            guard self.view !== view else { return }
            self.view = view
            model.onOutput = { [weak view] bytes in
                view?.feed(byteArray: ArraySlice(bytes))
            }
            model.onClear = { [weak view] in
                guard let view else { return }
                // The server replays the scrollback on attach; wipe first.
                view.getTerminal().resetToInitialState()
            }
            let terminal = view.getTerminal()
            model.attach(cols: terminal.cols, rows: terminal.rows)
        }

        // MARK: TerminalViewDelegate

        func send(source: SwiftTerm.TerminalView, data: ArraySlice<UInt8>) {
            model.send(Data(data))
        }

        func sizeChanged(source: SwiftTerm.TerminalView, newCols: Int, newRows: Int) {
            model.resize(cols: newCols, rows: newRows)
        }

        func clipboardCopy(source: SwiftTerm.TerminalView, content: Data) {
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            pasteboard.setString(String(decoding: content, as: UTF8.self), forType: .string)
        }

        func requestOpenLink(
            source: SwiftTerm.TerminalView, link: String, params: [String: String]
        ) {
            guard let url = URL(string: link), url.scheme == "http" || url.scheme == "https" else {
                return
            }
            NSWorkspace.shared.open(url)
        }

        func scrolled(source: SwiftTerm.TerminalView, position: Double) {}
        func setTerminalTitle(source: SwiftTerm.TerminalView, title: String) {}
        func rangeChanged(source: SwiftTerm.TerminalView, startY: Int, endY: Int) {}
        func bell(source: SwiftTerm.TerminalView) {}
        func iTermContent(source: SwiftTerm.TerminalView, content: ArraySlice<UInt8>) {}
        func hostCurrentDirectoryUpdate(source: SwiftTerm.TerminalView, directory: String?) {}
    }
}
```

If `swift build` reports unimplemented `TerminalViewDelegate` requirements, the pinned SwiftTerm
declares more than the list above; add an empty implementation for each one the compiler names —
none of them carry state this view needs.

- [ ] **Step 4: Write the pane (banner + prompt bar)**

Create `native/Apps/ShepherdMac/Sources/Terminal/TerminalPane.swift`:

```swift
import ShepherdKit
import SwiftUI

/// The terminal tab's body: the emulator, a state overlay, and the prompt bar.
struct TerminalPane: View {
    @Bindable var model: TerminalSessionModel
    @FocusState private var promptFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                TerminalHostView(model: model)
                    .accessibilityLabel(L.t("native_terminal_tab_title"))
                overlay
            }
            Divider()
            promptBar
        }
        .onDisappear { model.detach() }
    }

    @ViewBuilder
    private var overlay: some View {
        switch model.phase {
        case .idle, .live:
            EmptyView()
        case .connecting:
            statusCard(
                title: L.t("native_terminal_connecting"), body: nil, action: nil, systemImage: nil)
        case .superseded:
            statusCard(
                title: L.t("native_terminal_superseded_title"),
                body: L.t("native_terminal_superseded_body"),
                action: (L.t("native_terminal_superseded_action"), { model.takeOver() }),
                systemImage: "display.2"
            )
        case .ended(.gone), .ended(.stopped):
            statusCard(
                title: L.t("native_terminal_ended_title"),
                body: L.t("native_terminal_ended_body"),
                action: nil,
                systemImage: "moon.zzz"
            )
        case .ended(.unreachable), .ended(.superseded):
            statusCard(
                title: L.t("native_terminal_unreachable_title"),
                body: L.t("native_terminal_unreachable_body"),
                action: (L.t("common_retry"), { model.takeOver() }),
                systemImage: "exclamationmark.triangle"
            )
        }
    }

    /// A descriptive title, one short explanatory sentence, and the one next
    /// step — the house rule for explanatory surfaces.
    private func statusCard(
        title: String,
        body: String?,
        action: (label: String, run: () -> Void)?,
        systemImage: String?
    ) -> some View {
        VStack(spacing: 10) {
            if let systemImage {
                Image(systemName: systemImage).font(.largeTitle).foregroundStyle(.secondary)
            }
            Text(title).font(.headline)
            if let body {
                Text(body)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 360)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let action {
                Button(action.label, action: action.run).keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .shadow(radius: 8)
    }

    private var promptBar: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                TextField(L.t("native_terminal_prompt_placeholder"), text: $model.promptText)
                    .textFieldStyle(.roundedBorder)
                    .focused($promptFocused)
                    .onSubmit { Task { await model.submitPrompt() } }
                    .disabled(model.promptBusy)
                Button(L.t("native_terminal_prompt_send")) {
                    Task { await model.submitPrompt() }
                }
                .disabled(
                    model.promptBusy
                        || model.promptText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if let error = model.promptError {
                Text(error).font(.caption).foregroundStyle(.red)
            }
        }
        .padding(8)
    }
}
```

- [ ] **Step 5: Write the controller and the tab**

Create `native/Apps/ShepherdMac/Sources/Terminal/TerminalController.swift`:

```swift
import Observation
import ShepherdKit

/// Per-store terminal state: one `TerminalSessionModel` per session id.
///
/// An `AppExtension`, so `AppModel` creates it after the store exists and tears
/// it down with the store. A model therefore never outlives the client it
/// attached with, which is what makes the generation guard inside the model
/// sufficient.
@Observable
@MainActor
final class TerminalController: AppExtension {
    private let store: SessionStore
    private var models: [String: TerminalSessionModel] = [:]

    required init(store: SessionStore, app: AppModel) {
        self.store = store
    }

    /// The model for a session, created on first use. Terminals are cheap when
    /// idle (no socket until `attach`), and keeping them means switching away
    /// and back does not lose the prompt draft.
    func model(for sessionID: String) -> TerminalSessionModel {
        if let existing = models[sessionID] { return existing }
        let model = TerminalSessionModel(sessionID: sessionID, store: store)
        models[sessionID] = model
        return model
    }

    func teardown() {
        for model in models.values { model.detach() }
        models = [:]
    }
}
```

Create `native/Apps/ShepherdMac/Sources/Terminal/TerminalTab.swift`:

```swift
import ShepherdKit
import SwiftUI

/// The terminal detail tab. Order 0: the terminal is what the operator came for.
struct TerminalTab: DetailTab {
    let id = "terminal"
    var title: String { L.t("native_terminal_tab_title") }
    let systemImage = "terminal"
    let order = 0

    @MainActor
    func makeView(session: Session, store: SessionStore, app: AppModel) -> AnyView {
        // Backticks: `extension` is a keyword, and S0-prep's accessor is spelled
        // with them.
        guard let controller = app.`extension`(TerminalController.self) else {
            // The extension is registered by `TerminalInstall.install()`; if it
            // is missing the app is mid-teardown, so render nothing rather than
            // build a model against a dead store.
            return AnyView(EmptyView())
        }
        // Keyed by id so SwiftUI rebuilds the pane — and therefore re-runs
        // `attach` — when the operator selects a different session.
        return AnyView(TerminalPane(model: controller.model(for: session.id)).id(session.id))
    }
}

/// The stream's single entry point. The integration lane calls this from
/// `StreamRegistrations.installAll(into:)`; the tests call it directly.
///
/// No idempotence flag of its own: `DetailTabRegistry.register` is keyed by tab
/// id and `AppModel.register` by `ObjectIdentifier`, so both are last-wins.
@MainActor
enum TerminalInstall {
    static func install(into app: AppModel) {
        DetailTabRegistry.register(TerminalTab())
        app.register(TerminalController.self)
    }
}
```

`register` is an **instance** method on `AppModel` (S0-prep Task 3), and the extension accessor is
spelled `` app.`extension`(_:) `` with backticks because `extension` is a keyword.

- [ ] **Step 6: Run the app suite and watch it pass**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests
```

Expected: PASS — 12 tests across `TerminalStateTests` and `TerminalRegistrationTests`, plus every
pre-existing app test.

- [ ] **Step 7: Build the app and check the strings gate**

```bash
./native/scripts/build-app.sh
bun run check:strings
```

Expected: `** BUILD SUCCEEDED **` and `Localizable.xcstrings is up to date (<N> keys).`

- [ ] **Step 8: Commit**

```bash
git add native/Apps/ShepherdMac/Sources/Terminal/TerminalHostView.swift \
  native/Apps/ShepherdMac/Sources/Terminal/TerminalPane.swift \
  native/Apps/ShepherdMac/Sources/Terminal/TerminalController.swift \
  native/Apps/ShepherdMac/Sources/Terminal/TerminalTab.swift \
  native/Apps/ShepherdMac/Tests/TerminalStateTests.swift
git commit -m "feat(native): swiftterm terminal tab with takeover banner and prompt bar"
```

---

## Task 8: Full gate, live check, PR

**Files:**
- No new files. Regenerated artefacts only if a gate says they are stale.

**Interfaces:**
- Consumes: everything above.
- Produces: a green branch, a live-verified terminal, and a PR whose body names the one integration
  line the S0-int lane owns.

- [ ] **Step 1: Run every gate the branch touches**

```bash
bun run test:contract
bun run check:strings
(cd ui && bun run check:i18n)
./native/scripts/sync-contract.sh --check
swift test --package-path native
./native/scripts/test-app.sh -only-testing:ShepherdTests
./native/scripts/build-app.sh
```

Expected, in order: the contract suite passing; `Localizable.xcstrings is up to date`; the i18n gate
passing; `sync-contract: up to date`; the full Swift suite passing; the app unit bundle passing;
`** BUILD SUCCEEDED **`.

- [ ] **Step 2: Rebase onto `origin/main`**

```bash
git fetch origin
git rebase origin/main
```

Expected: no conflicts outside the marked contract blocks and the locale catalogs. A conflict inside
`# ── stream: terminal ──` … `# ── /stream: terminal ──` means another stream wrote into this
stream's block — keep both blocks, never delete a neighbour's. A **genuine** conflict in
`ui/messages/*.json` means two branches gave the same key different values: resolve it on the
merits, do not blind-pick a side.

- [ ] **Step 3: Live check against the operator's server**

Skipped unless `SHEPHERD_LIVE_BASE_URL` is set. This is a manual smoke, not a test:

```bash
test -n "$SHEPHERD_LIVE_BASE_URL" && ./native/scripts/build-app.sh && \
  open native/Apps/ShepherdMac/.build/Build/Products/Debug/Shepherd.app
```

Then, against the saved profile:

1. Select a session with a working agent. The **Terminal** tab is first and selected by default; its
   scrollback paints within a second.
2. Type `echo native-terminal-ok` and press Return. The echo appears — that is input, output and the
   attach size all working at once.
3. Resize the window. The TUI reflows; nothing is clipped. (` resize:` frames are what did it.)
4. Open the same session's terminal in the **web UI**. The Mac app shows
   "Another device has this terminal"; press **Take over** and the Mac repaints while the browser
   parks. This is the 4000 path end to end.
5. Type a sentence in the prompt bar and press Return. The agent reacts in the terminal; the field
   clears and no error appears. This is `/reply`.
6. Archive the session from the toolbar. The terminal shows "Session ended". This is the 4001 path.

Record the six outcomes in the PR body. **Never revoke the operator's token from automation.**

- [ ] **Step 4: Open the PR**

```bash
git push -u origin feat/native-terminal
gh pr create --title "feat(native): terminal stream — PTYConnection, SwiftTerm view, prompt bar" \
  --body-file - <<'BODY'
Stream S1 of the native-app parallel streams plan.

## What

- Contract: `POST /api/sessions/{id}/reply` (200/400/401/404/415) + `ReplyRequest`, and
  `x-shepherd-pty` prose that now names the pre-upgrade 404, the scrollback replay and the
  "never reconnect after 4000" rule. `test/contract/terminal.test.ts` pins all of it against the
  real server.
- Kit: `PTYConnection`, an actor over `/pty/{id}?cols=&rows=` with bearer upgrade,
  `AsyncStream<Data>` output, `send`/`resize` (control frame ` resize:<cols>:<rows>\n`),
  `lifecycle()`, capped backoff, and the close-code policy — 4000 parks, 4001 ends, eight
  immediate failures give up. Tested against a new `FakePTYServer` (`NWListener`).
- Kit: `ShepherdClient.replySession(id:text:)`.
- App: SwiftTerm 1.20.0 (pinned exactly), a `TerminalView` bridge, `TerminalSessionModel`
  (unit-tested state machine), a takeover banner with "Take over", and a prompt bar over `/reply`.
  Registered as `DetailTab` id `terminal`, order 0.

## Integration lane (S0-int) — one line

This stream deliberately does not edit `StreamRegistrations.swift`. Add, inside
`StreamRegistrations.installAll(into:)`:

```swift
TerminalInstall.install(into: app)
```

## Live check

<paste the six outcomes from Step 3 here>
BODY
```

- [ ] **Step 5: Commit any gate fixups and push**

```bash
git add -A
git commit -m "chore(native): gate fixups for the terminal stream"
git push
```

Skip this step if Step 1 produced no changes.

---

## Self-review

**Spec coverage.** Design spec sub-project 2b's `PTYConnection` paragraph → Tasks 2–3 (URL + bearer,
`AsyncStream<Data>`, `send`, `resize`, 4000 `.superseded`, 4001 `.gone`, 1 s retry doubling, eight
fast fails → `.unreachable`). Sub-project 4's "Terminal view" paragraph → Task 7 (SwiftTerm view,
JetBrains Mono with a system fallback, option-drag selection via `optionAsMetaKey = false`,
superseded overlay with "Take over", ended state). The stream brief's four scope items → Task 1
(contract + fixtures + drift test + prose), Tasks 2–3 (the actor), Task 5 + Task 7 (SwiftTerm
dependency, view, tab, prompt bar, banner) and Task 6 (state tests with `Gate`/`settle`), Task 8
step 3 (live check gated on `SHEPHERD_LIVE_BASE_URL`). File ownership: every file named in a task is
on the allow-list; the two exceptions are called out in place — one `private` → `internal` line in
`ShepherdClient.swift` (Task 4) and the `TerminalInstall.install()` call handed to S0-int (Task 7 /
Task 8).

**Placeholder scan.** No TBDs. Two compiler-driven instructions remain — the
`TerminalViewDelegate` requirement list (Task 7 step 3) and the close-code contingency (Task 3
step 3) — and both carry the full replacement code plus the exact signal that triggers them, so
neither is "figure it out later".

**Type consistency.** `PTYConnection.LifecycleEvent` cases are `.attached` / `.reattached` /
`.detached` / `.closed(Closure)` everywhere (Task 2 declaration, Task 3 tests, Task 6
`TerminalSessionModel.apply`). `Closure` cases are `.superseded` / `.gone` / `.unreachable` /
`.stopped` in the declaration, the kit tests, the model's `Phase.ended`, and the pane's overlay
switch. `PTYSize` is declared once, in the kit (Task 2 step 4 removes the test-local duplicate).
`PTYAttaching`'s members match `FakeAttachment`'s and `LivePTYAttachment`'s one for one.
`replySession(id:text:)` is the same name in the extension, its tests and
`TerminalSessionModel`'s convenience initialiser. All twelve `native_terminal_*` keys used in
`TerminalPane`, `TerminalTab` and `TerminalSessionModel` appear in `KEYS_TERMINAL` and in both
catalogs; the only non-terminal key used is `common_retry`, which is already in `KEYS`.

**Seam cross-check (fixed during review).** Checked against the merged S0-prep plan rather than
Appendix B: `AppModel.register` is an instance method, the accessor is `` app.`extension`(_:) ``,
`DetailTabRegistry.register` is last-wins per id with a `reset()`, the integration call site is
`StreamRegistrations.installAll(into:)` (not `ShepherdApp`), `KEYS_TERMINAL` must be alphabetically
sorted (it is), and the contract markers are `# ── stream: terminal ──` / `# ── /stream: terminal ──`
in both `paths:` and `components.schemas:`. Task 7 and the PR body were corrected accordingly.

**Strict-concurrency pass (fixed during review).** `onOutput` / `onClear` are declared with
`@MainActor` closure types — a bare `((Data) -> Void)?` assigned from the main-actor-isolated
`TerminalHostView.Coordinator` is a non-isolated conversion Swift 6 rejects. The `reply` closure in
the tests is nonisolated and `@Sendable`, so its calls into the `@MainActor` `Counter`/`Gate`
helpers are `await`ed rather than made synchronously.
