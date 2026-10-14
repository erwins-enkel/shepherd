# iOS Agent Sessions: epics with their chain — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the iOS session list, show an epic as a blue group with progress, status and cues,
show each child session's predecessors and successors on its card, fold the children without a
session into one row, and open an epic sheet with the whole flow.

**Architecture:** ShepherdKit gains a client call for the existing `GET /api/epic`. Pure
derivations (stages, chain, fold, meter, clock, titles) live in a new
`native/Sources/ShepherdAppCore/Epics/` folder and are tested with `swift test`. The iOS app
loads the full epic next to the summary in `IOSEpicDirectory`, re-reads it when a member session
moves, and renders new views in `native/Apps/ShepherdIOS/Sources/Sessions/`.

**Tech Stack:** Swift 6.2, SwiftUI (iOS 18), swift-openapi-generator types from
`contracts/openapi.swift.yaml`, Swift Testing (ShepherdKit/ShepherdAppCore tests), XCTest
(ShepherdIOS tests), Bun for the string catalog.

**Spec:** `docs/superpowers/specs/2026-10-14-ios-epic-sessions-design.md`. Design canvas
(private): <https://claude.ai/artifact/LqND3TDZd3rzqyPHiHVL9E>.

## Global Constraints

- No server, contract or Mac app change. `getEpic` and the `Epic*` schemas already exist in
  `contracts/openapi.swift.yaml`.
- Blue is the epic hue: `SessionListStyle.blue` (`#4a90d9`); the rail is
  `SessionListStyle.epicRail` (`#294459`, blue 30 % over `line`). Amber stays for in-flight work
  only (DESIGN.md Four-Light Rule).
- Every user-visible string goes through `L.t`. New keys use the `native_ios_epic_` prefix and
  live in `ui/messages/en.json` **and** `ui/messages/de.json`; every key the app uses is listed in
  `KEYS_IOS_EPICS` in `native/scripts/gen-strings.ts` (keep that array alphabetical), and the
  catalog is regenerated with `bun native/scripts/gen-strings.ts`.
- Touch targets are at least 44 pt. Text uses `sessionFont`. Hue never stands alone: every
  coloured chip and dot has a label or a glyph.
- Swift work runs on the Mac: `swift build --package-path native`, `swift test --package-path
  native`, and the iOS tests through the lock wrapper (see Task 11). Never `bun test`.
- Commits: Conventional Commits with scope, one logical change each (`feat(ios): …`,
  `test(core): …`).
- This plan was written on a Linux host without a Swift toolchain. The code follows the generated
  names visible in the contract (idiomatic naming); if a generated name differs (for example the
  type of `Epic.forecast`), adapt the call site and say so in the PR description.

## File Structure

| File                                                                    | Responsibility                                                          |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `native/Sources/ShepherdKit/Client/ShepherdClient+Compose.swift`        | Modify: `Epic*` typealiases, open-enum conformances, `epic(repoPath:parent:)` |
| `native/Sources/ShepherdAppCore/Epics/EpicFlow.swift`                   | Create: stages of the `blockedBy` graph; `EpicChild` state helpers      |
| `native/Sources/ShepherdAppCore/Epics/EpicChain.swift`                  | Create: one child's needs, stage and unlocks                            |
| `native/Sources/ShepherdAppCore/Epics/EpicMeter.swift`                  | Create: meter tones and the epic clock                                  |
| `native/Sources/ShepherdAppCore/Epics/EpicText.swift`                   | Create: display title, step title, number lists                         |
| `native/Sources/ShepherdAppCore/Epics/EpicFold.swift`                   | Create: children without a row, by stage, plus the summary              |
| `native/Sources/ShepherdAppCore/Epics/EpicDigest.swift`                 | Create: one loaded epic plus its flow; row matching                     |
| `native/Tests/ShepherdAppCoreTests/EpicFixtures.swift`                  | Create: epic JSON fixtures, including the real epic #111                |
| `native/Tests/ShepherdAppCoreTests/EpicFlowTests.swift`                 | Create                                                                  |
| `native/Tests/ShepherdAppCoreTests/EpicChainTests.swift`                | Create (chain, meter, clock, text)                                      |
| `native/Tests/ShepherdAppCoreTests/EpicFoldTests.swift`                 | Create (fold, digest)                                                   |
| `ui/messages/en.json`, `ui/messages/de.json`                            | Modify: new `native_ios_epic_*` keys                                    |
| `native/scripts/gen-strings.ts`                                         | Modify: `KEYS_IOS_EPICS`                                                |
| `native/Sources/ShepherdAppCore/Resources/…`                            | Regenerated by `gen-strings.ts`                                         |
| `native/Apps/ShepherdIOS/Sources/MultiServer/IOSMergedSessionPresentation.swift` | Modify: `EpicGroup.stages`                                     |
| `native/Apps/ShepherdIOS/Sources/Sessions/IOSEpicGroupSignals.swift`    | Create: cues and fingerprint of an epic group                           |
| `native/Apps/ShepherdIOS/Sources/Sessions/IOSEpicDirectory.swift`       | Modify: full epics, fingerprint reloads                                 |
| `native/Apps/ShepherdIOS/Sources/Sessions/SessionListStyle.swift`       | Modify: `epicRail`                                                      |
| `native/Apps/ShepherdIOS/Sources/Sessions/IOSEpicCopy.swift`            | Create: run chip, clock, stage and forecast copy                        |
| `native/Apps/ShepherdIOS/Sources/Sessions/IOSEpicViews.swift`           | Create: meter, state dot, run chip, cue chips, rail background          |
| `native/Apps/ShepherdIOS/Sources/Sessions/IOSEpicGroupHeader.swift`     | Rewrite: blue three-line header with badge button                       |
| `native/Apps/ShepherdIOS/Sources/Sessions/IOSEpicChainStrip.swift`      | Create: Braucht → Stufe → Gibt frei                                     |
| `native/Apps/ShepherdIOS/Sources/Sessions/SessionCardView.swift`        | Modify: optional chain strip                                            |
| `native/Apps/ShepherdIOS/Sources/Sessions/IOSEpicFoldRow.swift`         | Create: "Weitere Schritte (n)"                                          |
| `native/Apps/ShepherdIOS/Sources/Sessions/IOSEpicSheet.swift`           | Create: the epic sheet                                                  |
| `native/Apps/ShepherdIOS/Sources/Sessions/SessionListView.swift`        | Modify: wiring, rail, sheet, load identity                              |
| `native/Tests/ShepherdKitTests/ShepherdClientComposeTests.swift`        | Modify: `epic` decode and error tests                                   |
| `native/Apps/ShepherdIOS/Tests/IOSEpicGroupingTests.swift`              | Modify: cues, fingerprint, directory, strings, render                   |

New Swift files are picked up automatically: SwiftPM targets include their whole folder, and
XcodeGen (`project.yml`, `sources: - path: Sources`) globs the iOS sources on `xcodegen generate`,
which `test-ios-app.sh` runs.

---

### Task 1: ShepherdKit — read one epic

**Files:**
- Modify: `native/Sources/ShepherdKit/Client/ShepherdClient+Compose.swift`
- Test: `native/Tests/ShepherdKitTests/ShepherdClientComposeTests.swift`

**Interfaces:**
- Produces: `public typealias Epic`, `EpicChild`, `EpicTiming`, `EpicForecast`;
  `EpicChildState`, `EpicRunStatus`, `EpicForecastConfidence` conform to `OpenEnum` (so
  `.rawValue` gives the wire string); `ShepherdClient.epic(repoPath: String, parent: Int) async
  throws -> Epic`.

- [ ] **Step 1: Write the failing tests**

Add inside the existing suite in `ShepherdClientComposeTests.swift`, after the `epics()` test:

```swift
    @Test("one epic decodes with its children and dependency edges")
    func epic() async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.stub("GET", "/api/epic", status: 200, json: Data("""
            {"repoPath":"/repo","parentIssueNumber":111,"parentTitle":"Epic: Kalender","source":"native",
            "children":[{"number":101,"title":"Einplanen","url":"https://x/101","order":0,"body":"","blockedBy":[],
            "state":"running","sessionId":"s1","prNumber":112,"issueClosed":false,"integrationMerged":false,"claimed":true},
            {"number":102,"title":"Video","url":"https://x/102","order":1,"body":"","blockedBy":[101],
            "state":"blocked","sessionId":null,"prNumber":null,"issueClosed":false,"integrationMerged":false,"claimed":false}],
            "warnings":[],"run":{"repoPath":"/repo","parentIssueNumber":111,"mode":"auto","status":"running"},
            "forecast":null}
            """.utf8))
        let result = try await makeClient(server).epic(repoPath: "/repo", parent: 111)
        #expect(result.children.map(\.number) == [101, 102])
        #expect(result.children[1].blockedBy == [101])
        #expect(result.children[0].state.rawValue == "running")
        #expect(result.run.status.rawValue == "running")
        #expect(result.forecast == nil)
        let query = URLComponents(string: "http://fake/?\(server.requests().last?.query ?? "")")?.queryItems
        #expect(query?.first(where: { $0.name == "repo" })?.value == "/repo")
        #expect(query?.first(where: { $0.name == "parent" })?.value == "111")
    }

    @Test("epic maps documented errors", arguments: [400, 401, 404, 503])
    func epicErrors(status: Int) async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.stub("GET", "/api/epic", status: status, json: try Fixtures.errorJSON("bad"))
        let expected: ShepherdError = switch status {
        case 400: .badRequest("bad")
        case 401: .unauthenticated
        case 404: .notFound
        default: .upstreamFailure(code: nil, message: "bad")
        }
        await #expect(throws: expected) { _ = try await makeClient(server).epic(repoPath: "/repo", parent: 111) }
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `swift test --package-path native --filter ShepherdClientComposeTests`
Expected: build failure, `value of type 'ShepherdClient' has no member 'epic'`.

- [ ] **Step 3: Implement**

In `ShepherdClient+Compose.swift`, after `public typealias EpicListing = …`:

```swift
public typealias Epic = Components.Schemas.Epic
public typealias EpicChild = Components.Schemas.EpicChild
public typealias EpicTiming = Components.Schemas.EpicTiming
public typealias EpicForecast = Components.Schemas.EpicForecast
```

After `extension Components.Schemas.SlashCommandKind: OpenEnum {}`:

```swift
extension Components.Schemas.EpicChildState: OpenEnum {}
extension Components.Schemas.EpicRunStatus: OpenEnum {}
extension Components.Schemas.EpicForecastConfidence: OpenEnum {}
```

After `public func epics(repoPath:)`:

```swift
    public func epic(repoPath: String, parent: Int) async throws -> Epic {
        do {
            switch try await generated.getEpic(.init(query: .init(repo: repoPath, parent: parent))) {
            case .ok(let ok): return try ok.body.json
            case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .notFound: throw ShepherdError.notFound
            case .serviceUnavailable(let value): throw ShepherdError.fromUpstream(try value.body.json)
            case .undocumented(let statusCode, _):
                throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "getEpic")
            }
        } catch { throw ShepherdError.from(error, route: "getEpic") }
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `swift test --package-path native --filter ShepherdClientComposeTests`
Expected: PASS, including the four `epicErrors` arguments.

- [ ] **Step 5: Commit**

```bash
git add native/Sources/ShepherdKit/Client/ShepherdClient+Compose.swift native/Tests/ShepherdKitTests/ShepherdClientComposeTests.swift
git commit -m "feat(kit): read one epic with its children"
```

---

### Task 2: AppCore — epic stages (`EpicFlow`)

**Files:**
- Create: `native/Sources/ShepherdAppCore/Epics/EpicFlow.swift`
- Create: `native/Tests/ShepherdAppCoreTests/EpicFixtures.swift`
- Create: `native/Tests/ShepherdAppCoreTests/EpicFlowTests.swift`

**Interfaces:**
- Consumes: `Epic`, `EpicChild`, `EpicChildState.rawValue` (Task 1).
- Produces:
  - `public struct EpicFlow: Sendable, Equatable` with `init(_ children: [EpicChild])`,
    `stages: [EpicFlow.Stage]`, `blockers: [Int: [Int]]`, `func stage(of number: Int) -> Int?`,
    `var firstParallelStage: Int?`, `var currentStage: Int?`.
  - `public struct EpicFlow.Stage: Sendable, Equatable` with `index: Int` (1-based),
    `children: [EpicChild]`, `var parallel: Bool`.
  - `extension EpicChild { public var isMerged: Bool; public var isInFlight: Bool; public var isReady: Bool }`.
  - Test helper `EpicFixtures.epic(_:parent:title:status:extra:)` and
    `EpicFixtures.content111(_ states: [Int: String] = [:], sessions: [Int: String] = [:])`.

- [ ] **Step 1: Write the fixtures**

`native/Tests/ShepherdAppCoreTests/EpicFixtures.swift`:

```swift
import Foundation
import ShepherdKit

/// Epics the way `GET /api/epic` answers them; children take `order` from their position.
enum EpicFixtures {
    struct Child {
        let number: Int
        var blockedBy: [Int] = []
        var state = "blocked"
        var sessionId: String? = nil
        var title: String? = nil
    }

    static func epic(_ children: [Child], parent: Int = 111, title: String = "Epic: Content-Plan-Kalender",
                     status: String = "running", extra: String = "") throws -> Epic {
        let rows = children.enumerated().map { index, child in
            let session = child.sessionId.map { "\"\($0)\"" } ?? "null"
            return """
                {"number":\(child.number),"title":"\(child.title ?? "Child \(child.number)")",\
                "url":"https://github.com/o/r/issues/\(child.number)","order":\(index),"body":"",\
                "blockedBy":\(child.blockedBy),"state":"\(child.state)","sessionId":\(session),\
                "prNumber":null,"issueClosed":false,"integrationMerged":false,"claimed":false}
                """
        }.joined(separator: ",")
        let json = """
            {"repoPath":"/repos/media","parentIssueNumber":\(parent),"parentTitle":"\(title)",\
            "source":"native","children":[\(rows)],"warnings":[],\
            "run":{"repoPath":"/repos/media","parentIssueNumber":\(parent),"mode":"auto","status":"\(status)"}\(extra)}
            """
        return try JSONDecoder().decode(Epic.self, from: Data(json.utf8))
    }

    /// Epic #111 of media-bib-and-rendering: #101 → #102, #103; #103 → #104–#106, #108–#110;
    /// #106 → #107. #101 runs, the rest are blocked unless `states` says otherwise.
    static func content111(_ states: [Int: String] = [:], sessions: [Int: String] = [:]) throws -> Epic {
        let edges: [Int: [Int]] = [102: [101], 103: [101], 104: [103], 105: [103], 106: [103],
                                   107: [106], 108: [103], 109: [103], 110: [103]]
        return try epic((101...110).map { number in
            Child(number: number, blockedBy: edges[number] ?? [],
                  state: states[number] ?? (number == 101 ? "running" : "blocked"), sessionId: sessions[number])
        })
    }

    static func allMerged() -> [Int: String] {
        Dictionary(uniqueKeysWithValues: (101...110).map { ($0, "merged") })
    }
}
```

- [ ] **Step 2: Write the failing tests**

`native/Tests/ShepherdAppCoreTests/EpicFlowTests.swift`:

```swift
import Testing
import ShepherdKit

@testable import ShepherdAppCore

extension CoreSeamTests {
/// The rules are `layoutEpicFlow` / `firstParallelStage` in ui/src/lib/epic-flow.ts.
struct EpicFlowTests {
    private func numbers(_ flow: EpicFlow) -> [[Int]] { flow.stages.map { $0.children.map(\.number) } }

    @Test func stagesFollowTheLongestBlockerPath() throws {
        let flow = EpicFlow(try EpicFixtures.content111().children)
        #expect(numbers(flow) == [[101], [102, 103], [104, 105, 106, 108, 109, 110], [107]])
        #expect(flow.stage(of: 107) == 4)
        #expect(flow.stage(of: 999) == nil)
        #expect(flow.stages.map(\.parallel) == [false, true, true, false])
        #expect(flow.blockers[107] == [106])
    }

    @Test func firstParallelAndCurrentStageSkipMergedChildren() throws {
        let fresh = EpicFlow(try EpicFixtures.content111().children)
        #expect(fresh.firstParallelStage == 2)
        #expect(fresh.currentStage == 1)
        let later = EpicFlow(try EpicFixtures.content111([101: "merged", 102: "merged", 103: "merged"]).children)
        #expect(later.firstParallelStage == 3)
        #expect(later.currentStage == 3)
        let done = EpicFlow(try EpicFixtures.content111(EpicFixtures.allMerged()).children)
        #expect(done.currentStage == nil)
        #expect(done.firstParallelStage == nil)
    }

    @Test func selfReferencesOutsideEdgesAndDuplicatesAreIgnored() throws {
        let flow = EpicFlow(try EpicFixtures.epic([
            .init(number: 1, blockedBy: [1, 99]),
            .init(number: 2, blockedBy: [1, 1]),
        ]).children)
        #expect(numbers(flow) == [[1], [2]])
        #expect(flow.blockers[1] == [])
        #expect(flow.blockers[2] == [1])
    }

    @Test func aCycleDropsTheEdgeThatClosesIt() throws {
        // Walked in order: #1 visits #2, whose edge back to #1 closes the cycle and is skipped.
        let flow = EpicFlow(try EpicFixtures.epic([
            .init(number: 1, blockedBy: [2]),
            .init(number: 2, blockedBy: [1]),
        ]).children)
        #expect(numbers(flow) == [[2], [1]])
    }

    @Test func withinAStageChildrenFollowTheirBlockersRows() throws {
        let flow = EpicFlow(try EpicFixtures.epic([
            .init(number: 1), .init(number: 2),
            .init(number: 3, blockedBy: [2]), .init(number: 4, blockedBy: [1]),
        ]).children)
        #expect(numbers(flow) == [[1, 2], [4, 3]])
    }

    @Test func noChildrenNoStages() {
        let flow = EpicFlow([])
        #expect(flow.stages.isEmpty)
        #expect(flow.currentStage == nil)
    }
}
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `swift test --package-path native --filter EpicFlowTests`
Expected: build failure, `cannot find 'EpicFlow' in scope`.

- [ ] **Step 4: Implement**

`native/Sources/ShepherdAppCore/Epics/EpicFlow.swift`:

```swift
import Foundation
import ShepherdKit

extension EpicChild {
    public var isMerged: Bool { state.rawValue == "merged" }
    /// Running or in review: work in flight (the web's `inFlight` in epic-timing-text.ts).
    public var isInFlight: Bool { state.rawValue == "running" || state.rawValue == "in-review" }
    public var isReady: Bool { state.rawValue == "ready" }
}

/// The stages of an epic's `blockedBy` graph — a port of `layoutEpicFlow` in
/// ui/src/lib/epic-flow.ts. A child with no blocker inside the epic sits in stage 1, every other
/// one right after its latest blocker. Self-references and blockers outside the epic are ignored;
/// on a cycle the edge that closes it is dropped, so every child gets a finite stage. Children are
/// walked in epic `order`; within a stage they sort by the mean row of their blockers, then by
/// `order`.
public struct EpicFlow: Sendable, Equatable {
    public struct Stage: Sendable, Equatable {
        /// 1-based.
        public let index: Int
        public let children: [EpicChild]
        public var parallel: Bool { children.count >= 2 }
    }

    public let stages: [Stage]
    /// Each child's blockers inside the epic: deduplicated, self-references dropped.
    public let blockers: [Int: [Int]]

    public init(_ children: [EpicChild]) {
        let sorted = children.sorted { $0.order != $1.order ? $0.order < $1.order : $0.number < $1.number }
        let inEpic = Set(sorted.map(\.number))
        var preds: [Int: [Int]] = [:]
        for child in sorted {
            var seen: Set<Int> = []
            preds[child.number] = child.blockedBy.filter {
                $0 != child.number && inEpic.contains($0) && seen.insert($0).inserted
            }
        }

        var stageOf: [Int: Int] = [:]
        var onStack: Set<Int> = []
        var kept: [(from: Int, to: Int)] = []
        func visit(_ number: Int) -> Int {
            if let known = stageOf[number] { return known }
            onStack.insert(number)
            var stage = 1
            for blocker in preds[number] ?? [] where !onStack.contains(blocker) {
                stage = max(stage, visit(blocker) + 1)
                kept.append((from: blocker, to: number))
            }
            onStack.remove(number)
            stageOf[number] = stage
            return stage
        }
        for child in sorted { _ = visit(child.number) }

        var rowOf: [Int: Int] = [:]
        func meanBlockerRow(_ number: Int) -> Double {
            let rows = kept.filter { $0.to == number }.map { Double(rowOf[$0.from] ?? 0) }
            return rows.isEmpty ? 0 : rows.reduce(0, +) / Double(rows.count)
        }
        var built: [Stage] = []
        let count = stageOf.values.max() ?? 0
        if count > 0 {
            for index in 1...count {
                let members = sorted.enumerated()
                    .filter { stageOf[$0.element.number] == index }
                    .map { (child: $0.element, rank: $0.offset, key: meanBlockerRow($0.element.number)) }
                    .sorted { $0.key != $1.key ? $0.key < $1.key : $0.rank < $1.rank }
                    .map { $0.child }
                for (row, child) in members.enumerated() { rowOf[child.number] = row }
                built.append(Stage(index: index, children: members))
            }
        }
        stages = built
        blockers = preds
    }

    public func stage(of number: Int) -> Int? {
        stages.first { $0.children.contains { $0.number == number } }?.index
    }

    /// First stage with at least two unmerged children — where more agent slots start to pay off.
    public var firstParallelStage: Int? {
        stages.first { $0.children.filter { !$0.isMerged }.count >= 2 }?.index
    }

    /// The lowest stage that still has an unmerged child; nil once every child is merged.
    public var currentStage: Int? {
        stages.first { $0.children.contains { !$0.isMerged } }?.index
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `swift test --package-path native --filter EpicFlowTests`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add native/Sources/ShepherdAppCore/Epics/EpicFlow.swift native/Tests/ShepherdAppCoreTests/EpicFixtures.swift native/Tests/ShepherdAppCoreTests/EpicFlowTests.swift
git commit -m "feat(core): derive epic stages from the blockedBy graph"
```

---

### Task 3: AppCore — chain, meter, clock and text

**Files:**
- Create: `native/Sources/ShepherdAppCore/Epics/EpicChain.swift`
- Create: `native/Sources/ShepherdAppCore/Epics/EpicMeter.swift`
- Create: `native/Sources/ShepherdAppCore/Epics/EpicText.swift`
- Create: `native/Tests/ShepherdAppCoreTests/EpicChainTests.swift`

**Interfaces:**
- Consumes: `EpicFlow`, `EpicChild.isMerged/isInFlight` (Task 2), `EpicTiming` (Task 1).
- Produces:
  - `public struct EpicChain: Sendable, Equatable` with `init?(_ number: Int, flow: EpicFlow,
    children: [EpicChild])`, `number`, `stage`, `stageCount`, `needs: [EpicChain.Need]`,
    `unlocks: [Int]`, `parallel: Int`, `isLast: Bool`; `EpicChain.Need` has `number: Int`,
    `merged: Bool`.
  - `public enum EpicMeterTone: Sendable, Equatable { case merged, inFlight, rest }`;
    `EpicMeter.tones(_ children: [EpicChild]) -> [EpicMeterTone]`,
    `EpicMeter.tones(merged: Int, total: Int) -> [EpicMeterTone]`.
  - `EpicClock.runMs(_ timing: EpicTiming, now: Int) -> Int`.
  - `EpicText.displayTitle(_:) -> String`, `EpicText.stepTitle(_:parent:) -> String`,
    `EpicText.numbers(_ list: [Int], prefix: String = "") -> String`.

- [ ] **Step 1: Write the failing tests**

`native/Tests/ShepherdAppCoreTests/EpicChainTests.swift`:

```swift
import Testing
import ShepherdKit

@testable import ShepherdAppCore

extension CoreSeamTests {
/// The rules are `childUnlocks` (epic-child.ts), `epicMeter`, `runMs` and `stepTitle`
/// (epic-timing-text.ts) in ui/src/lib.
struct EpicChainTests {
    private func chain(_ number: Int, _ epic: Epic) throws -> EpicChain {
        try #require(EpicChain(number, flow: EpicFlow(epic.children), children: epic.children))
    }

    @Test func theFirstChildNeedsNothingAndFreesTwoInParallel() throws {
        let chain = try chain(101, EpicFixtures.content111())
        #expect(chain.needs.isEmpty)
        #expect(chain.stage == 1 && chain.stageCount == 4)
        #expect(chain.unlocks == [102, 103])
        #expect(chain.parallel == 2)
        #expect(!chain.isLast)
    }

    @Test func aMergedPredecessorIsMarkedAndTheFanOutCounts() throws {
        let chain = try chain(103, EpicFixtures.content111([101: "merged", 103: "running"]))
        #expect(chain.needs == [.init(number: 101, merged: true)])
        #expect(chain.stage == 2)
        #expect(chain.unlocks == [104, 105, 106, 108, 109, 110])
        #expect(chain.parallel == 6)
    }

    @Test func anOutOfOrderStartShowsTheOpenBlocker() throws {
        let chain = try chain(102, EpicFixtures.content111([102: "running"]))
        #expect(chain.needs == [.init(number: 101, merged: false)])
        #expect(chain.unlocks.isEmpty && chain.parallel == 0)
    }

    @Test func theLastChildIsMarkedOnceEveryOtherOneMerged() throws {
        var states = EpicFixtures.allMerged()
        states[107] = "running"
        let chain = try chain(107, EpicFixtures.content111(states))
        #expect(chain.isLast)
        #expect(chain.unlocks.isEmpty)
        #expect(chain.stage == 4 && chain.stageCount == 4)
    }

    @Test func aNumberOutsideTheEpicHasNoChain() throws {
        let epic = try EpicFixtures.content111()
        #expect(EpicChain(999, flow: EpicFlow(epic.children), children: epic.children) == nil)
    }

    @Test func meterTonesFollowEpicOrder() throws {
        let epic = try EpicFixtures.content111([101: "merged", 102: "in-review", 103: "ready"])
        #expect(EpicMeter.tones(epic.children)
            == [.merged, .inFlight, .rest, .rest, .rest, .rest, .rest, .rest, .rest, .rest])
        #expect(EpicMeter.tones(merged: 2, total: 4) == [.merged, .merged, .rest, .rest])
        #expect(EpicMeter.tones(merged: 0, total: 0).isEmpty)
    }

    @Test func theClockSubtractsPausesAndStandsStillWhilePaused() throws {
        func timing(_ fields: String) throws -> EpicTiming {
            try #require(try EpicFixtures.epic([.init(number: 1)], extra: ",\"timing\":{\(fields)}").timing)
        }
        let rest = "\"landingStartedAt\":null,\"landedAt\":null,\"agentMs\":0,\"idleMs\":0"
        let running = try timing("\"startedAt\":1000,\"pausedAt\":null,\"pausedMs\":200,\(rest)")
        #expect(EpicClock.runMs(running, now: 5_000) == 3_800)
        let paused = try timing("\"startedAt\":1000,\"pausedAt\":3000,\"pausedMs\":0,\(rest)")
        #expect(EpicClock.runMs(paused, now: 9_000) == 2_000)
        let never = try timing("\"startedAt\":null,\"pausedAt\":null,\"pausedMs\":0,\(rest)")
        #expect(EpicClock.runMs(never, now: 9_000) == 0)
    }

    @Test func titlesDropRedundantPrefixes() {
        #expect(EpicText.displayTitle("Epic: Content-Plan-Kalender") == "Content-Plan-Kalender")
        #expect(EpicText.displayTitle("EPIC:   Spuren") == "Spuren")
        #expect(EpicText.displayTitle("Epic:") == "Epic:")
        #expect(EpicText.displayTitle("Epics in iOS") == "Epics in iOS")
        #expect(EpicText.stepTitle("Stack-Angleichung (#158): Sortierung", parent: 158) == "Sortierung")
        #expect(EpicText.stepTitle("Stack (#1580): Sortierung", parent: 158) == "Stack (#1580): Sortierung")
        #expect(EpicText.stepTitle("Einplanen: je Konto", parent: 111) == "Einplanen: je Konto")
    }

    @Test func numberListsShowTwoThenACount() {
        #expect(EpicText.numbers([]) == "")
        #expect(EpicText.numbers([102]) == "#102")
        #expect(EpicText.numbers([102, 103]) == "#102 · #103")
        #expect(EpicText.numbers([104, 105, 106, 108]) == "#104 · #105 +2")
        #expect(EpicText.numbers([101], prefix: "✓ ") == "✓ #101")
    }
}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `swift test --package-path native --filter EpicChainTests`
Expected: build failure, `cannot find 'EpicChain' in scope`.

- [ ] **Step 3: Implement**

`native/Sources/ShepherdAppCore/Epics/EpicChain.swift`:

```swift
import Foundation
import ShepherdKit

/// One child's place in its epic: what it needs, its stage, and what it frees — the web's
/// "Braucht zuerst → Dieses Issue → Gibt frei" (EpicChildSteps.svelte, epic-child.ts).
public struct EpicChain: Sendable, Equatable {
    public struct Need: Sendable, Equatable {
        public let number: Int
        public let merged: Bool
    }

    public let number: Int
    public let stage: Int
    public let stageCount: Int
    /// The child's blockers inside the epic, merged or not.
    public let needs: [Need]
    /// Unmerged siblings that wait on this child, in epic order.
    public let unlocks: [Int]
    /// How many of `unlocks` become startable once this child lands (no other open blocker).
    public let parallel: Int
    /// Every other child is merged: the epic lands after this one.
    public let isLast: Bool

    public init?(_ number: Int, flow: EpicFlow, children: [EpicChild]) {
        guard let stage = flow.stage(of: number) else { return nil }
        let merged = Set(children.filter(\.isMerged).map(\.number))
        let dependents = children
            .sorted { $0.order != $1.order ? $0.order < $1.order : $0.number < $1.number }
            .filter { $0.number != number && !$0.isMerged && $0.blockedBy.contains(number) }
        self.number = number
        self.stage = stage
        stageCount = flow.stages.count
        needs = (flow.blockers[number] ?? []).map { Need(number: $0, merged: merged.contains($0)) }
        unlocks = dependents.map(\.number)
        parallel = dependents.filter { $0.blockedBy.allSatisfy { $0 == number || merged.contains($0) } }.count
        isLast = children.allSatisfy { $0.number == number || $0.isMerged }
    }
}
```

`native/Sources/ShepherdAppCore/Epics/EpicMeter.swift`:

```swift
import Foundation
import ShepherdKit

public enum EpicMeterTone: Sendable, Equatable { case merged, inFlight, rest }

/// The EPIC badge's meter (the web's `epicMeter`): one segment per child in epic order.
public enum EpicMeter {
    public static func tones(_ children: [EpicChild]) -> [EpicMeterTone] {
        children
            .sorted { $0.order != $1.order ? $0.order < $1.order : $0.number < $1.number }
            .map { $0.isMerged ? .merged : $0.isInFlight ? .inFlight : .rest }
    }

    /// The summary-only meter (EpicBadge without a live epic): merged first, the rest after.
    public static func tones(merged: Int, total: Int) -> [EpicMeterTone] {
        (0..<max(0, total)).map { $0 < merged ? .merged : .rest }
    }
}

public enum EpicClock {
    /// The epic clock (the web's `runMs`): `(pausedAt ?? landingStartedAt ?? now) − startedAt −
    /// pausedMs`; 0 before the first start.
    public static func runMs(_ timing: EpicTiming, now: Int) -> Int {
        guard let started = timing.startedAt else { return 0 }
        return max(0, (timing.pausedAt ?? timing.landingStartedAt ?? now) - started - timing.pausedMs)
    }
}
```

`native/Sources/ShepherdAppCore/Epics/EpicText.swift`:

```swift
import Foundation

public enum EpicText {
    /// The parent title without a leading "Epic:" — the EPIC badge already says it.
    public static func displayTitle(_ title: String) -> String {
        let trimmed = title.trimmingCharacters(in: .whitespaces)
        guard trimmed.lowercased().hasPrefix("epic:") else { return trimmed }
        let rest = trimmed.dropFirst(5).trimmingCharacters(in: .whitespaces)
        return rest.isEmpty ? trimmed : rest
    }

    /// A child's title without a redundant parent prefix ("Stack-Angleichung (#158): …"): the
    /// segment before the first ": " goes only when it names the parent's number (the web's
    /// `stepTitle`).
    public static func stepTitle(_ title: String, parent: Int) -> String {
        guard let colon = title.range(of: ": ") else { return title }
        let head = title[..<colon.lowerBound]
        let tag = "#\(parent)"
        var search = head.startIndex..<head.endIndex
        while let hit = head.range(of: tag, range: search) {
            if hit.upperBound == head.endIndex || !head[hit.upperBound].isNumber {
                return String(title[colon.upperBound...])
            }
            search = hit.upperBound..<head.endIndex
        }
        return title
    }

    /// "#102 · #103": at most two numbers, then "+k".
    public static func numbers(_ list: [Int], prefix: String = "") -> String {
        let shown = list.prefix(2).map { "\(prefix)#\($0)" }.joined(separator: " · ")
        return list.count > 2 ? "\(shown) +\(list.count - 2)" : shown
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `swift test --package-path native --filter EpicChainTests`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add native/Sources/ShepherdAppCore/Epics/EpicChain.swift native/Sources/ShepherdAppCore/Epics/EpicMeter.swift native/Sources/ShepherdAppCore/Epics/EpicText.swift native/Tests/ShepherdAppCoreTests/EpicChainTests.swift
git commit -m "feat(core): derive an epic child's chain, the meter and the clock"
```

---

### Task 4: AppCore — fold and digest

**Files:**
- Create: `native/Sources/ShepherdAppCore/Epics/EpicFold.swift`
- Create: `native/Sources/ShepherdAppCore/Epics/EpicDigest.swift`
- Create: `native/Tests/ShepherdAppCoreTests/EpicFoldTests.swift`

**Interfaces:**
- Consumes: `EpicFlow`, `EpicChain`, `EpicMeter` (Tasks 2–3).
- Produces:
  - `public struct EpicFold: Sendable, Equatable` with `init(flow: EpicFlow, children:
    [EpicChild], shown: Set<Int>)`, `stages: [EpicFold.Stage]`, `var count: Int`,
    `summary: EpicFold.Summary?`. `Stage` has `index: Int`, `after: [Int]`, `items: [Item]`;
    `Item` has `child: EpicChild`, `unlocks: Int`. `Summary` is `.ready(count: Int)` or
    `.waiting(on: [Int])`.
  - `public struct EpicDigest: Sendable` with `init(_ epic: Epic)`, `epic`, `flow`, `total`,
    `merged`, `inFlight`, `meter`, `func child(session id: String, issue: Int?) -> EpicChild?`,
    `func chain(_ number: Int) -> EpicChain?`, `func fold(shown: Set<Int>) -> EpicFold`.

- [ ] **Step 1: Write the failing tests**

`native/Tests/ShepherdAppCoreTests/EpicFoldTests.swift`:

```swift
import Testing
import ShepherdKit

@testable import ShepherdAppCore

extension CoreSeamTests {
struct EpicFoldTests {
    private func fold(_ epic: Epic, shown: Set<Int>) -> EpicFold {
        EpicFold(flow: EpicFlow(epic.children), children: epic.children, shown: shown)
    }

    @Test func foldsEveryUnmergedChildWithoutARowByStage() throws {
        let fold = fold(try EpicFixtures.content111(), shown: [101])
        #expect(fold.count == 9)
        #expect(fold.stages.map(\.index) == [2, 3, 4])
        #expect(fold.stages.map(\.after) == [[101], [103], [106]])
        #expect(fold.stages[1].items.map(\.child.number) == [104, 105, 106, 108, 109, 110])
        #expect(fold.stages[0].items.map(\.unlocks) == [0, 6])
        #expect(fold.summary == .waiting(on: [101]))
    }

    @Test func readyChildrenLeadTheSummary() throws {
        let fold = fold(try EpicFixtures.content111([101: "merged", 102: "ready", 103: "running"]), shown: [103])
        #expect(fold.stages.first?.items.map(\.child.number) == [102])
        #expect(fold.summary == .ready(count: 1))
    }

    @Test func mergedBlockersLeaveNothingToWaitOn() throws {
        // #102 is folded and its only blocker #101 is merged: no open blocker to name.
        let fold = fold(try EpicFixtures.content111([101: "merged", 103: "merged"]), shown: [])
        #expect(fold.stages.first?.items.map(\.child.number) == [102])
        #expect(fold.summary == nil)
    }

    @Test func nothingFoldedNoSummary() throws {
        let fold = fold(try EpicFixtures.content111(EpicFixtures.allMerged()), shown: [])
        #expect(fold.count == 0)
        #expect(fold.summary == nil)
    }

    @Test func aDigestMatchesRowsBySessionThenIssue() throws {
        let digest = EpicDigest(try EpicFixtures.content111(sessions: [101: "s-101"]))
        #expect(digest.child(session: "s-101", issue: nil)?.number == 101)
        #expect(digest.child(session: "other", issue: 103)?.number == 103)
        #expect(digest.child(session: "other", issue: nil) == nil)
        #expect(digest.total == 10 && digest.merged == 0 && digest.inFlight == 1)
        #expect(digest.meter.first == .inFlight)
        #expect(digest.chain(101)?.unlocks == [102, 103])
        #expect(digest.fold(shown: [101]).count == 9)
    }
}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `swift test --package-path native --filter EpicFoldTests`
Expected: build failure, `cannot find 'EpicFold' in scope`.

- [ ] **Step 3: Implement**

`native/Sources/ShepherdAppCore/Epics/EpicFold.swift`:

```swift
import Foundation
import ShepherdKit

/// The children an epic group shows no session for, by stage — the iOS list's folded
/// "Weitere Schritte" row.
public struct EpicFold: Sendable, Equatable {
    public struct Item: Sendable, Equatable {
        public let child: EpicChild
        /// Unmerged siblings waiting on it.
        public let unlocks: Int
    }

    public struct Stage: Sendable, Equatable {
        public let index: Int
        /// The listed children's in-epic blockers, ascending.
        public let after: [Int]
        public let items: [Item]
    }

    public enum Summary: Sendable, Equatable {
        /// Children of the lowest folded stage that are ready to start.
        case ready(count: Int)
        /// The lowest folded stage waits on these open (unmerged) blockers.
        case waiting(on: [Int])
    }

    public let stages: [Stage]
    public let summary: Summary?
    public var count: Int { stages.reduce(0) { $0 + $1.items.count } }

    public init(flow: EpicFlow, children: [EpicChild], shown: Set<Int>) {
        let merged = Set(children.filter(\.isMerged).map(\.number))
        let open = children.filter { !$0.isMerged }
        let built: [Stage] = flow.stages.compactMap { stage in
            let items = stage.children
                .filter { !$0.isMerged && !shown.contains($0.number) }
                .map { child in
                    Item(child: child, unlocks: open.filter {
                        $0.number != child.number && $0.blockedBy.contains(child.number)
                    }.count)
                }
            guard !items.isEmpty else { return nil }
            let after = Set(items.flatMap { flow.blockers[$0.child.number] ?? [] }).sorted()
            return Stage(index: stage.index, after: after, items: items)
        }
        stages = built
        if let first = built.first {
            let ready = first.items.filter { $0.child.isReady }.count
            let waitingOn = first.after.filter { !merged.contains($0) }
            summary = ready > 0 ? .ready(count: ready) : waitingOn.isEmpty ? nil : .waiting(on: waitingOn)
        } else {
            summary = nil
        }
    }
}
```

`native/Sources/ShepherdAppCore/Epics/EpicDigest.swift`:

```swift
import Foundation
import ShepherdKit

/// One loaded epic and everything the iOS epic surfaces derive from it, computed once per load.
public struct EpicDigest: Sendable {
    public let epic: Epic
    public let flow: EpicFlow

    public init(_ epic: Epic) {
        self.epic = epic
        flow = EpicFlow(epic.children)
    }

    public var total: Int { epic.children.count }
    public var merged: Int { epic.children.filter(\.isMerged).count }
    public var inFlight: Int { epic.children.filter(\.isInFlight).count }
    public var meter: [EpicMeterTone] { EpicMeter.tones(epic.children) }

    /// The child a session works on: by session id, else by issue number.
    public func child(session id: String, issue: Int?) -> EpicChild? {
        epic.children.first { $0.sessionId == id }
            ?? issue.flatMap { number in epic.children.first { $0.number == number } }
    }

    public func chain(_ number: Int) -> EpicChain? {
        EpicChain(number, flow: flow, children: epic.children)
    }

    public func fold(shown: Set<Int>) -> EpicFold {
        EpicFold(flow: flow, children: epic.children, shown: shown)
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `swift test --package-path native --filter "EpicFoldTests|EpicChainTests|EpicFlowTests"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add native/Sources/ShepherdAppCore/Epics/EpicFold.swift native/Sources/ShepherdAppCore/Epics/EpicDigest.swift native/Tests/ShepherdAppCoreTests/EpicFoldTests.swift
git commit -m "feat(core): fold epic children without a session and digest a loaded epic"
```

---

### Task 5: Copy — catalog keys for the iOS epic surfaces

**Files:**
- Modify: `ui/messages/en.json`, `ui/messages/de.json`
- Modify: `native/scripts/gen-strings.ts` (`KEYS_IOS_EPICS`)
- Regenerated: `native/Sources/ShepherdAppCore/Resources/Catalog/Localizable.xcstrings`,
  `…/en.lproj/Localizable.strings`, `…/de.lproj/Localizable.strings`

**Interfaces:**
- Produces: the keys below, usable through `L.t`. Placeholders map to `%n$@` in order of first
  appearance in the **EN** string, so pass arguments in that order.

- [ ] **Step 1: Add the keys to `ui/messages/en.json`** (append before the closing brace; the
  catalog is not sorted):

```json
  "native_ios_epic_after": "after {deps}",
  "native_ios_epic_chain_aria": "Needs {needs}. Stage {stage} of {total}: #{number}. Unlocks {unlocks}.",
  "native_ios_epic_fold_next_after": "next after {deps}",
  "native_ios_epic_fold_ready": "{count} ready",
  "native_ios_epic_frees": "frees {count}",
  "native_ios_epic_in_flight": "{count} in progress",
  "native_ios_epic_lands": "lands ~{when} · confidence {word}",
  "native_ios_epic_lands_next": "then the epic lands",
  "native_ios_epic_more_steps": "More steps ({count})",
  "native_ios_epic_need_open": "{deps} open",
  "native_ios_epic_needs": "Needs",
  "native_ios_epic_needs_none": "nothing",
  "native_ios_epic_now": "Now",
  "native_ios_epic_open_aria": "Open epic #{number}, {merged} of {total} merged",
  "native_ios_epic_open_web": "Open in browser",
  "native_ios_epic_parallel": "{count} in parallel",
  "native_ios_epic_paused": "paused",
  "native_ios_epic_remaining": "~{duration} left once resumed",
  "native_ios_epic_since": "for {duration}",
  "native_ios_epic_slots_hint": "More agent slots only help from stage {stage}.",
  "native_ios_epic_stage": "Stage {stage}/{total}",
  "native_ios_epic_stage_after": "Stage {stage} · after {deps}",
  "native_ios_epic_stage_only": "Stage {stage}",
  "native_ios_epic_unlocks_none": "nothing waits"
```

- [ ] **Step 2: Add the same keys to `ui/messages/de.json`:**

```json
  "native_ios_epic_after": "nach {deps}",
  "native_ios_epic_chain_aria": "Braucht {needs}. Stufe {stage} von {total}: #{number}. Gibt frei: {unlocks}.",
  "native_ios_epic_fold_next_after": "als Nächstes nach {deps}",
  "native_ios_epic_fold_ready": "{count} bereit",
  "native_ios_epic_frees": "gibt {count} frei",
  "native_ios_epic_in_flight": "{count} in Arbeit",
  "native_ios_epic_lands": "landet ~{when} · Sicherheit {word}",
  "native_ios_epic_lands_next": "dann landet das Epic",
  "native_ios_epic_more_steps": "Weitere Schritte ({count})",
  "native_ios_epic_need_open": "{deps} offen",
  "native_ios_epic_needs": "Braucht",
  "native_ios_epic_needs_none": "nichts",
  "native_ios_epic_now": "Jetzt",
  "native_ios_epic_open_aria": "Epic #{number} öffnen, {merged} von {total} zusammengeführt",
  "native_ios_epic_open_web": "Im Browser öffnen",
  "native_ios_epic_parallel": "{count} parallel",
  "native_ios_epic_paused": "pausiert",
  "native_ios_epic_remaining": "noch ~{duration} ab Fortsetzen",
  "native_ios_epic_since": "seit {duration}",
  "native_ios_epic_slots_hint": "Mehr Agenten-Plätze helfen erst ab Stufe {stage}.",
  "native_ios_epic_stage": "Stufe {stage}/{total}",
  "native_ios_epic_stage_after": "Stufe {stage} · nach {deps}",
  "native_ios_epic_stage_only": "Stufe {stage}",
  "native_ios_epic_unlocks_none": "nichts wartet"
```

- [ ] **Step 3: Replace `KEYS_IOS_EPICS` in `native/scripts/gen-strings.ts`** (reused web keys plus
  the new ones, alphabetical):

```ts
/** iOS epic headings, chain strip, fold row and sheet. Reused web copy plus `native_ios_epic_*`;
 *  the short EPIC label is in KEYS_QUEUES. */
export const KEYS_IOS_EPICS: readonly string[] = [
  "childrun_step_unlocks",
  "epic_badge",
  "epic_group_collapse_aria",
  "epic_group_cue_blocked",
  "epic_group_cue_changes_requested",
  "epic_group_cue_ci_failed",
  "epic_group_cue_merge_blocked",
  "epic_group_cue_ready",
  "epic_group_expand_aria",
  "epic_role_leading",
  "epic_state_in_review",
  "epic_state_running",
  "epic_tip_confidence_high",
  "epic_tip_confidence_low",
  "epic_tip_confidence_medium",
  "epic_tip_confidence_repo_only",
  "epic_tip_confidence_very_low",
  "epicflow_legend_active",
  "epicflow_legend_merged",
  "epicflow_legend_ready",
  "epicflow_legend_waiting",
  "epicflow_merged",
  "epicflow_stage_first",
  "epicflow_stage_parallel",
  "epicflow_title",
  "native_ios_epic_after",
  "native_ios_epic_chain_aria",
  "native_ios_epic_fold_next_after",
  "native_ios_epic_fold_ready",
  "native_ios_epic_frees",
  "native_ios_epic_in_flight",
  "native_ios_epic_lands",
  "native_ios_epic_lands_next",
  "native_ios_epic_more_steps",
  "native_ios_epic_need_open",
  "native_ios_epic_needs",
  "native_ios_epic_needs_none",
  "native_ios_epic_now",
  "native_ios_epic_open_aria",
  "native_ios_epic_open_web",
  "native_ios_epic_parallel",
  "native_ios_epic_paused",
  "native_ios_epic_remaining",
  "native_ios_epic_since",
  "native_ios_epic_slots_hint",
  "native_ios_epic_stage",
  "native_ios_epic_stage_after",
  "native_ios_epic_stage_only",
  "native_ios_epic_unlocks_none",
];
```

- [ ] **Step 4: Regenerate and check**

Run:

```bash
bun native/scripts/gen-strings.ts
bun native/scripts/gen-strings.ts --check
(cd ui && bun run check:i18n)
bunx prettier --check ui/messages/en.json ui/messages/de.json native/scripts/gen-strings.ts
```

Expected: the generator writes the three catalog files; `--check` and `check:i18n` pass. If the
generator reports `keys claimed by more than one stream manifest`, remove the named key from
`KEYS_IOS_EPICS` (another stream already ships it) and rerun.

- [ ] **Step 5: Commit**

```bash
git add ui/messages/en.json ui/messages/de.json native/scripts/gen-strings.ts native/Sources/ShepherdAppCore/Resources
git commit -m "feat(ios): add copy for epic chains, folds and the epic sheet"
```

---

### Task 6: iOS — group stages, cues and fingerprint

**Files:**
- Modify: `native/Apps/ShepherdIOS/Sources/MultiServer/IOSMergedSessionPresentation.swift`
- Create: `native/Apps/ShepherdIOS/Sources/Sessions/IOSEpicGroupSignals.swift`
- Test: `native/Apps/ShepherdIOS/Tests/IOSEpicGroupingTests.swift`

**Interfaces:**
- Produces: `EpicGroup.stages: [String: HerdStage]` (session id → lifecycle stage);
  `struct IOSEpicCues: Equatable` (`ciFailed`, `needsRework`, `mergeBlocked`, `ready`, `blocked`,
  `isEmpty`); `EpicGroup.cues: IOSEpicCues`; `EpicGroup.fingerprint: String`.

- [ ] **Step 1: Write the failing test** (add to `IOSEpicGroupingTests`):

```swift
    func testCuesTallyMemberStagesAndTheFingerprintFollowsMoves() {
        var blocked = session("c", parent: 100, issue: 103)
        blocked.status = .init(known: .blocked)
        let group = IOSMergedSessionPresentation.merge([source(profile("one"),
            active: [session("a", parent: 100, issue: 101), blocked],
            ready: [session("b", parent: 100, issue: 102)])], selectedRepos: []).epicGroups[0]
        XCTAssertEqual(group.stages["b"], .ready)
        XCTAssertEqual(group.cues, IOSEpicCues(ready: 1, blocked: 1))
        XCTAssertFalse(group.cues.isEmpty)
        let moved = IOSMergedSessionPresentation.merge([source(profile("one"),
            active: [session("a", parent: 100, issue: 101), session("b", parent: 100, issue: 102), blocked])],
            selectedRepos: []).epicGroups[0]
        XCTAssertNotEqual(group.fingerprint, moved.fingerprint)
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run (on the Mac, from the repository root):
`native/scripts/uitest-lock.sh native/scripts/test-ios-app.sh unit`
Expected: build failure, `value of type 'EpicGroup' has no member 'stages'`.

- [ ] **Step 3: Implement**

In `IOSMergedSessionPresentation.swift`, extend `EpicGroup`:

```swift
    struct EpicGroup: Identifiable {
        let id: String
        let profile: ServerProfile
        let repoPath: String
        let parentNumber: Int
        var rows: [Row]
        /// Each member's lifecycle stage, by session id: the header's cues and the reload
        /// fingerprint read it.
        var stages: [String: HerdStage] = [:]
        var repoName: String { (repoPath as NSString).lastPathComponent }
    }
```

and in `merge`, right after `epics[key]?.rows.append(row)`:

```swift
                epics[key]?.stages[row.session.id] = stage
```

Create `native/Apps/ShepherdIOS/Sources/Sessions/IOSEpicGroupSignals.swift`:

```swift
import ShepherdAppCore
import ShepherdKit

/// The web's per-group tallies (`cuesFor` in Herd.svelte); a chip shows only when its count is
/// above zero.
struct IOSEpicCues: Equatable {
    var ciFailed = 0
    var needsRework = 0
    var mergeBlocked = 0
    var ready = 0
    var blocked = 0
    var isEmpty: Bool { self == IOSEpicCues() }
}

extension IOSMergedSessionPresentation.EpicGroup {
    var cues: IOSEpicCues {
        var cues = IOSEpicCues()
        for row in rows {
            switch stages[row.session.id] {
            case .ciFailed: cues.ciFailed += 1
            case .needsRework: cues.needsRework += 1
            case .branchProtectionBlocked: cues.mergeBlocked += 1
            case .ready: cues.ready += 1
            default: break
            }
            if row.session.status.known == .blocked { cues.blocked += 1 }
        }
        return cues
    }

    /// Changes whenever a member session appears, leaves or moves (lifecycle stage or status);
    /// the directory re-reads the epic then.
    var fingerprint: String {
        rows.map { "\($0.session.id):\(stages[$0.session.id]?.rawValue ?? "-"):\($0.session.status.rawValue)" }
            .sorted().joined(separator: ",")
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `native/scripts/uitest-lock.sh native/scripts/test-ios-app.sh unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add native/Apps/ShepherdIOS/Sources/MultiServer/IOSMergedSessionPresentation.swift native/Apps/ShepherdIOS/Sources/Sessions/IOSEpicGroupSignals.swift native/Apps/ShepherdIOS/Tests/IOSEpicGroupingTests.swift
git commit -m "feat(ios): tally epic group cues and fingerprint its members"
```

---

### Task 7: iOS — load the full epic in `IOSEpicDirectory`

**Files:**
- Modify: `native/Apps/ShepherdIOS/Sources/Sessions/IOSEpicDirectory.swift`
- Test: `native/Apps/ShepherdIOS/Tests/IOSEpicGroupingTests.swift`

**Interfaces:**
- Consumes: `ShepherdClient.epic(repoPath:parent:)` (Task 1), `EpicDigest` (Task 4),
  `EpicGroup.fingerprint` (Task 6).
- Produces: `IOSEpicDirectory.init(read:readEpic:)`, `func digest(_ group: EpicGroup, owner:
  AppModel) -> EpicDigest?`. `summary(_:owner:)` and `load(_:owners:fallback:force:)` keep their
  signatures; `load` now also re-reads when a group's fingerprint changed.

- [ ] **Step 1: Write the failing test** (add to `IOSEpicGroupingTests`; it reuses the hub setup
  of `testDirectoryCachesPerRepoAndRefreshesNewParentsAndPullToRefresh`):

```swift
    func testDirectoryKeepsTheFullEpicAndRereadsWhenAMemberMoves() async throws {
        URLProtocol.registerClass(IOSMultiServerFixtureTransport.self)
        let launch = try IOSLaunchEnvironment(configuration: .init(isIsolated: true))
        let hub = IOSServerHub(launch: launch)
        let profile = try hub.catalogue.addRemoteProfile(name: "Epics", address: "https://epics-full.multi.fixture.invalid")
        try launch.credentials.save(.init(token: "fixture", tokenId: "fixture"), for: profile.credentialKey)
        IOSMultiServerFixtureTransport.set([], for: profile.baseURL)
        await hub.connect(profile)
        defer { hub.disconnect(profile.id) }
        let owner = try XCTUnwrap(hub.models[profile.id])
        try await owner.store?.bootstrap()
        let epic = try JSONDecoder().decode(Epic.self, from: Data(#"""
            {"repoPath":"/repos/app","parentIssueNumber":100,"parentTitle":"Epic: Ship","source":"native",
            "children":[{"number":101,"title":"First","url":"https://x/101","order":0,"body":"","blockedBy":[],
            "state":"running","sessionId":"a","prNumber":null,"issueClosed":false,"integrationMerged":false,"claimed":true},
            {"number":102,"title":"Second","url":"https://x/102","order":1,"body":"","blockedBy":[101],
            "state":"blocked","sessionId":null,"prNumber":null,"issueClosed":false,"integrationMerged":false,"claimed":false}],
            "warnings":[],"run":{"repoPath":"/repos/app","parentIssueNumber":100,"mode":"auto","status":"running"}}
            """#.utf8))
        var epicReads = 0
        var failEpic = false
        let directory = IOSEpicDirectory(read: { _, _ in .init(epics: [], subIssues: []) }, readEpic: { _, path, parent in
            epicReads += 1
            XCTAssertEqual(path, "/repos/app")
            XCTAssertEqual(parent, 100)
            if failEpic { throw URLError(.notConnectedToInternet) }
            return epic
        })
        let running = IOSMergedSessionPresentation.merge([source(profile,
            active: [session("a", parent: 100, issue: 101)])], selectedRepos: []).epicGroups
        await directory.load(running, owners: hub.models, fallback: owner)
        await directory.load(running, owners: hub.models, fallback: owner)
        XCTAssertEqual(epicReads, 1)
        XCTAssertEqual(try XCTUnwrap(directory.digest(running[0], owner: owner)).chain(101)?.unlocks, [102])
        // The member moves to Ready: the fingerprint changes and the epic is read again.
        let moved = IOSMergedSessionPresentation.merge([source(profile, active: [],
            ready: [session("a", parent: 100, issue: 101)])], selectedRepos: []).epicGroups
        failEpic = true
        await directory.load(moved, owners: hub.models, fallback: owner)
        XCTAssertEqual(epicReads, 2)
        XCTAssertNotNil(directory.digest(moved[0], owner: owner), "a failed re-read keeps the last known epic")
        hub.disconnect(profile.id)
        XCTAssertNil(directory.digest(moved[0], owner: owner))
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `native/scripts/uitest-lock.sh native/scripts/test-ios-app.sh unit`
Expected: build failure, `extra argument 'readEpic' in call`.

- [ ] **Step 3: Implement** — replace `IOSEpicDirectory.swift` with:

```swift
import Foundation
import Observation
import ShepherdAppCore
import ShepherdKit

/// Repo summaries and full epics belong to the owning model's activation, never to a session ID.
@MainActor
@Observable
final class IOSEpicDirectory {
    private struct Entry {
        let owner: ObjectIdentifier
        let generation: Int
        let request: UUID
        var parents: Set<Int>
        var fingerprint: String
        var summaries: [EpicSummary]
        var digests: [Int: EpicDigest]
    }
    private var entries: [String: Entry] = [:]
    @ObservationIgnored private let read: (ShepherdClient, String) async throws -> EpicListing
    @ObservationIgnored private let readEpic: (ShepherdClient, String, Int) async throws -> Epic

    init(read: @escaping (ShepherdClient, String) async throws -> EpicListing = {
        try await $0.epics(repoPath: $1)
    }, readEpic: @escaping (ShepherdClient, String, Int) async throws -> Epic = {
        try await $0.epic(repoPath: $1, parent: $2)
    }) {
        self.read = read
        self.readEpic = readEpic
    }

    private func key(_ group: IOSMergedSessionPresentation.EpicGroup) -> String {
        "\(group.profile.id):\(group.repoPath)"
    }

    private func entry(_ group: IOSMergedSessionPresentation.EpicGroup, owner: AppModel) -> Entry? {
        guard let entry = entries[key(group)], entry.owner == ObjectIdentifier(owner),
            entry.generation == owner.activationGeneration else { return nil }
        return entry
    }

    func summary(_ group: IOSMergedSessionPresentation.EpicGroup, owner: AppModel) -> EpicSummary? {
        entry(group, owner: owner)?.summaries.first { $0.parentIssueNumber == group.parentNumber }
    }

    func digest(_ group: IOSMergedSessionPresentation.EpicGroup, owner: AppModel) -> EpicDigest? {
        entry(group, owner: owner)?.digests[group.parentNumber]
    }

    func load(_ groups: [IOSMergedSessionPresentation.EpicGroup], owners: [UUID: AppModel],
              fallback: AppModel, force: Bool = false) async {
        let repos = Dictionary(grouping: groups, by: key)
        for (key, groups) in repos {
            guard let group = groups.first else { continue }
            let owner = owners[group.profile.id] ?? fallback
            guard owner.activeProfile?.id == group.profile.id, let store = owner.store else { continue }
            let identity = ObjectIdentifier(owner), generation = owner.activationGeneration
            let parents = Set(groups.map(\.parentNumber))
            let fingerprint = groups.map(\.fingerprint).sorted().joined(separator: "|")
            let old = entries[key]
            let sameActivation = old?.owner == identity && old?.generation == generation
            if !force, sameActivation, parents.isSubset(of: old?.parents ?? []),
               old?.fingerprint == fingerprint { continue }
            let request = UUID()
            entries[key] = Entry(owner: identity, generation: generation, request: request,
                parents: sameActivation ? old?.parents ?? [] : [],
                fingerprint: sameActivation ? old?.fingerprint ?? "" : "",
                summaries: sameActivation ? old?.summaries ?? [] : [],
                digests: sameActivation ? old?.digests ?? [:] : [:])
            let listing = try? await read(store.client, group.repoPath)
            guard current(key, request, owner, generation, store) else { continue }
            var digests: [Int: EpicDigest] = [:]
            for parent in parents.sorted() {
                if let epic = try? await readEpic(store.client, group.repoPath, parent) {
                    digests[parent] = EpicDigest(epic)
                }
                guard current(key, request, owner, generation, store) else { break }
            }
            guard current(key, request, owner, generation, store) else { continue }
            // A failed read retains the known copy; unknown parents use the number-only header.
            entries[key]?.parents.formUnion(parents)
            entries[key]?.fingerprint = fingerprint
            if let listing { entries[key]?.summaries = listing.epics }
            entries[key]?.digests.merge(digests) { _, new in new }
        }
    }

    /// Whether `request` still owns `key` for this activation; a stale one drops its entry.
    private func current(_ key: String, _ request: UUID, _ owner: AppModel, _ generation: Int,
                         _ store: SessionStore) -> Bool {
        guard !Task.isCancelled, owner.activationGeneration == generation, owner.store === store,
            entries[key]?.request == request else {
            if entries[key]?.request == request { entries[key] = nil }
            return false
        }
        return true
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `native/scripts/uitest-lock.sh native/scripts/test-ios-app.sh unit`
Expected: PASS, including the existing
`testDirectoryCachesPerRepoAndRefreshesNewParentsAndPullToRefresh` (its `read` closure is
unchanged; the default `readEpic` hits the fixture transport and fails quietly, which only
leaves `digest` nil).

- [ ] **Step 5: Commit**

```bash
git add native/Apps/ShepherdIOS/Sources/Sessions/IOSEpicDirectory.swift native/Apps/ShepherdIOS/Tests/IOSEpicGroupingTests.swift
git commit -m "feat(ios): load the full epic and re-read it when a member moves"
```

---

### Task 8: iOS — shared epic views and the blue header

**Files:**
- Modify: `native/Apps/ShepherdIOS/Sources/Sessions/SessionListStyle.swift`
- Create: `native/Apps/ShepherdIOS/Sources/Sessions/IOSEpicCopy.swift`
- Create: `native/Apps/ShepherdIOS/Sources/Sessions/IOSEpicViews.swift`
- Rewrite: `native/Apps/ShepherdIOS/Sources/Sessions/IOSEpicGroupHeader.swift`
- Test: `native/Apps/ShepherdIOS/Tests/IOSEpicGroupingTests.swift`

**Interfaces:**
- Consumes: `EpicDigest`, `EpicMeter`, `EpicClock`, `EpicText` (Tasks 2–4), `IOSEpicCues`
  (Task 6), keys (Task 5).
- Produces:
  - `SessionListStyle.epicRail: Color`.
  - `enum IOSEpicCopy` with `runChip(_ epic: Epic) -> String?`, `clock(_ epic: Epic, now: Int)
    -> String?`, `stage(_ digest: EpicDigest) -> String?`, `forecast(_ epic: Epic, locale:
    Locale = .current) -> String?`, `confidence(_ forecast: EpicForecast) -> String`.
  - Views: `IOSEpicMeter(tones:height:spacing:)`, `IOSEpicDotTone`, `IOSEpicStateDot(tone:)` with
    `static func tone(_ child: EpicChild) -> IOSEpicDotTone`, `IOSEpicRunChip(text:)`,
    `IOSEpicCueChips(cues:)`, `IOSEpicRailBackground(rail:)`.
  - `IOSEpicGroupHeader(group:summary:digest:collapsed:now:toggle:open:)`; `digest`, `now` and
    `open` have defaults, so today's call `IOSEpicGroupHeader(group:summary:collapsed:toggle:)`
    still compiles.

- [ ] **Step 1: Write the failing test** (add to `IOSEpicGroupingTests`):

```swift
    func testEpicCopyNamesRunClockAndStage() throws {
        let epic = try JSONDecoder().decode(Epic.self, from: Data(#"""
            {"repoPath":"/repos/app","parentIssueNumber":100,"parentTitle":"Epic: Ship","source":"native",
            "children":[{"number":101,"title":"First","url":"https://x/101","order":0,"body":"","blockedBy":[],
            "state":"running","sessionId":"a","prNumber":null,"issueClosed":false,"integrationMerged":false,"claimed":true}],
            "warnings":[],"run":{"repoPath":"/repos/app","parentIssueNumber":100,"mode":"auto","status":"running"},
            "timing":{"startedAt":0,"pausedAt":null,"pausedMs":0,"landingStartedAt":null,"landedAt":null,"agentMs":0,"idleMs":0}}
            """#.utf8))
        XCTAssertEqual(IOSEpicCopy.runChip(epic), L.t("epic_role_leading"))
        XCTAssertEqual(IOSEpicCopy.clock(epic, now: 10_020_000), L.t("native_ios_epic_since", "2h 47m"))
        XCTAssertEqual(IOSEpicCopy.stage(EpicDigest(epic)), L.t("native_ios_epic_stage", "1", "1"))
        XCTAssertNil(IOSEpicCopy.forecast(epic))
    }
```

(10 020 000 ms is 2 h 47 min, which `IOSSessionListPresentation.elapsed` renders as `2h 47m`.)

- [ ] **Step 2: Run it to verify it fails**

Run: `native/scripts/uitest-lock.sh native/scripts/test-ios-app.sh unit`
Expected: build failure, `cannot find 'IOSEpicCopy' in scope`.

- [ ] **Step 3: Add the rail colour** — in `SessionListStyle`, after `static let slate`:

```swift
    /// Epic blue at 30 % over `line`: the web's `color-mix(in srgb, blue 30%, line)` for the
    /// epic header rule and the rail tying member rows to it.
    static let epicRail = color(0x294459)
```

- [ ] **Step 4: Create `IOSEpicCopy.swift`**

```swift
import Foundation
import ShepherdAppCore
import ShepherdKit

/// Copy shared by the epic header and the epic sheet.
enum IOSEpicCopy {
    /// The run's chip: "führt" while it runs, "pausiert" while paused, none when idle.
    static func runChip(_ epic: Epic) -> String? {
        switch epic.run.status.rawValue {
        case "running": L.t("epic_role_leading")
        case "paused": L.t("native_ios_epic_paused")
        default: nil
        }
    }

    static func clock(_ epic: Epic, now: Int) -> String? {
        guard let timing = epic.timing, timing.startedAt != nil else { return nil }
        let ms = EpicClock.runMs(timing, now: now)
        return L.t("native_ios_epic_since", IOSSessionListPresentation.elapsed(now - ms, now: now))
    }

    static func stage(_ digest: EpicDigest) -> String? {
        guard let stage = digest.flow.currentStage else { return nil }
        return L.t("native_ios_epic_stage", String(stage), String(digest.flow.stages.count))
    }

    static func forecast(_ epic: Epic, locale: Locale = .current) -> String? {
        guard let forecast = epic.forecast else { return nil }
        if let finish = forecast.finishAt {
            let when = Date(timeIntervalSince1970: Double(finish) / 1_000)
                .formatted(.dateTime.weekday(.abbreviated).hour().minute().locale(locale))
            return L.t("native_ios_epic_lands", when, confidence(forecast))
        }
        if let remaining = forecast.remainingMsFromResume {
            return L.t("native_ios_epic_remaining", IOSSessionListPresentation.elapsed(0, now: remaining))
        }
        return nil
    }

    /// The web's `confidenceWord`: marked when only the repo median backs it.
    static func confidence(_ forecast: EpicForecast) -> String {
        let word = switch forecast.confidence.rawValue {
        case "very-low": L.t("epic_tip_confidence_very_low")
        case "low": L.t("epic_tip_confidence_low")
        case "medium": L.t("epic_tip_confidence_medium")
        case "high": L.t("epic_tip_confidence_high")
        default: forecast.confidence.rawValue
        }
        return forecast.epicSamples == 0 ? L.t("epic_tip_confidence_repo_only", word) : word
    }
}
```

- [ ] **Step 5: Create `IOSEpicViews.swift`**

```swift
import SwiftUI
import ShepherdAppCore
import ShepherdKit

/// One segment per child: blue merged, amber in flight, line colour otherwise.
struct IOSEpicMeter: View {
    let tones: [EpicMeterTone]
    var height: CGFloat = 2
    var spacing: CGFloat = 1

    var body: some View {
        HStack(spacing: spacing) {
            ForEach(Array(tones.enumerated()), id: \.offset) { _, tone in
                RoundedRectangle(cornerRadius: 1).fill(Self.color(tone))
                    .frame(maxWidth: .infinity).frame(height: height)
            }
        }
        .accessibilityHidden(true)
    }

    static func color(_ tone: EpicMeterTone) -> Color {
        switch tone {
        case .merged: SessionListStyle.blue
        case .inFlight: SessionListStyle.amber
        case .rest: SessionListStyle.brightLine
        }
    }
}

enum IOSEpicDotTone { case ready, active, waiting, merged }

/// The flow's state dot: they differ in fill as well as hue, and always sit next to a label.
struct IOSEpicStateDot: View {
    let tone: IOSEpicDotTone

    var body: some View {
        Group {
            switch tone {
            case .ready: Circle().fill(SessionListStyle.green)
            case .active: Circle().fill(SessionListStyle.amber)
            case .merged: Circle().fill(SessionListStyle.slate)
            case .waiting: Circle().stroke(SessionListStyle.muted, lineWidth: 1.5)
            }
        }
        .frame(width: 8, height: 8)
        .accessibilityHidden(true)
    }

    static func tone(_ child: EpicChild) -> IOSEpicDotTone {
        child.isMerged ? .merged : child.isInFlight ? .active : child.isReady ? .ready : .waiting
    }
}

/// Neutral role chip ("führt", "pausiert"): it says who owns the run, not how it is going.
struct IOSEpicRunChip: View {
    let text: String

    var body: some View {
        Text(verbatim: text.uppercased()).tracking(0.8)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .foregroundStyle(SessionListStyle.muted)
            .overlay { RoundedRectangle(cornerRadius: 2).stroke(SessionListStyle.brightLine, lineWidth: 1) }
    }
}

/// The web's epic cue chips; the glyph keeps two same-hue chips apart.
struct IOSEpicCueChips: View {
    let cues: IOSEpicCues

    var body: some View {
        HStack(spacing: 4) {
            chip("✕", cues.ciFailed, SessionListStyle.red, "epic_group_cue_ci_failed")
            chip("✓", cues.ready, SessionListStyle.green, "epic_group_cue_ready")
            chip("!", cues.needsRework, SessionListStyle.amber, "epic_group_cue_changes_requested")
            chip("!", cues.mergeBlocked, SessionListStyle.amber, "epic_group_cue_merge_blocked")
            chip("!", cues.blocked, SessionListStyle.red, "epic_group_cue_blocked")
        }
        .fixedSize()
    }

    @ViewBuilder
    private func chip(_ glyph: String, _ count: Int, _ tint: Color, _ key: StaticString) -> some View {
        if count > 0 {
            Text(verbatim: "\(glyph) \(count)").monospacedDigit()
                .foregroundStyle(tint)
                .padding(.horizontal, 5).padding(.vertical, 1)
                .overlay { RoundedRectangle(cornerRadius: 2).stroke(tint, lineWidth: 1) }
                .accessibilityLabel(Text(verbatim: L.t(key, String(count))))
        }
    }
}

/// A list row background; for an epic member it carries the hairline rail under the header's
/// chevron, run 3 pt past the row so it bridges the list's 6 pt row spacing.
struct IOSEpicRailBackground: View {
    var rail = true

    var body: some View {
        SessionListStyle.background.overlay(alignment: .leading) {
            if rail {
                Rectangle().fill(SessionListStyle.epicRail).frame(width: 1)
                    .padding(.vertical, -3).padding(.leading, 17)
            }
        }
    }
}
```

- [ ] **Step 6: Rewrite `IOSEpicGroupHeader.swift`**

```swift
import SwiftUI
import ShepherdKit
import ShepherdAppCore

/// The blue epic group header: repo · EPIC badge, title · #parent, then run, clock, stage and
/// cues. Blue is the epic hue (the web's EpicGroupHeader); amber stays for work in flight.
struct IOSEpicGroupHeader: View {
    let group: IOSMergedSessionPresentation.EpicGroup
    let summary: EpicSummary?
    var digest: EpicDigest? = nil
    let collapsed: Bool
    var now = 0
    let toggle: () -> Void
    /// Opens the epic sheet; nil while the full epic is unknown, and the badge is then no button.
    var open: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Button(action: toggle) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                            .foregroundStyle(SessionListStyle.blue).frame(width: 12)
                        Text(verbatim: group.repoName).foregroundStyle(SessionListStyle.muted).lineLimit(1)
                    }
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        if let title {
                            Text(verbatim: title).sessionFont(weight: .semibold)
                                .foregroundStyle(SessionListStyle.bright).lineLimit(1).truncationMode(.tail)
                        }
                        Text(verbatim: "#\(group.parentNumber)").foregroundStyle(SessionListStyle.blue).fixedSize()
                    }
                    .padding(.leading, 20)
                    if digest != nil || !group.cues.isEmpty {
                        statusLine.padding(.leading, 20)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(.isHeader)
            .accessibilityLabel(Text(verbatim: L.t(collapsed ? "epic_group_expand_aria" : "epic_group_collapse_aria",
                String(group.parentNumber))))
            .accessibilityValue(Text(verbatim: accessibilityValue))
            .accessibilityIdentifier("herd-epic-\(group.parentNumber)")
            badge
        }
        .sessionFont(label: true, weight: .medium)
        .padding(.top, 10).padding(.bottom, 6)
        .overlay(alignment: .top) { Rectangle().fill(SessionListStyle.epicRail).frame(height: 1) }
        .listRowInsets(EdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 10))
        .listRowBackground(SessionListStyle.background).listRowSeparator(.hidden)
    }

    private var title: String? {
        (digest?.epic.parentTitle ?? summary?.parentTitle).map(EpicText.displayTitle)
    }

    private var counts: (merged: Int, total: Int)? {
        if let digest { return (merged: digest.merged, total: digest.total) }
        return summary.map { (merged: $0.merged, total: $0.total) }
    }

    private var badgeText: String {
        counts.map { L.t("epic_badge", String($0.merged), String($0.total)) } ?? L.t("upnext_pill_epic").uppercased()
    }

    private var tones: [EpicMeterTone] {
        digest?.meter ?? counts.map { EpicMeter.tones(merged: $0.merged, total: $0.total) } ?? []
    }

    @ViewBuilder private var badge: some View {
        let label = Text(verbatim: badgeText).monospacedDigit().fixedSize()
            .padding(.bottom, 5)
            .overlay(alignment: .bottom) { IOSEpicMeter(tones: tones) }
            .padding(.horizontal, 7).padding(.vertical, 4)
            .foregroundStyle(SessionListStyle.blue)
            .overlay { RoundedRectangle(cornerRadius: 2).stroke(SessionListStyle.blue, lineWidth: 1) }
        if let open, let counts {
            Button(action: open) { label.frame(minHeight: 44).contentShape(Rectangle()) }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(verbatim: L.t("native_ios_epic_open_aria",
                    String(group.parentNumber), String(counts.merged), String(counts.total))))
                .accessibilityIdentifier("herd-epic-open-\(group.parentNumber)")
        } else {
            label.frame(minHeight: 44).accessibilityHidden(true)
        }
    }

    private var statusLine: some View {
        HStack(spacing: 8) {
            if let chip = digest.flatMap({ IOSEpicCopy.runChip($0.epic) }) { IOSEpicRunChip(text: chip) }
            if let clock = digest.flatMap({ IOSEpicCopy.clock($0.epic, now: now) }) { Text(verbatim: clock) }
            if let stage = digest.flatMap(IOSEpicCopy.stage) { Text(verbatim: stage) }
            Spacer(minLength: 0)
            IOSEpicCueChips(cues: group.cues)
        }
        .foregroundStyle(SessionListStyle.muted)
        .lineLimit(1)
    }

    private var accessibilityValue: String {
        [group.repoName, title, badgeText, digest.flatMap { IOSEpicCopy.runChip($0.epic) },
         digest.flatMap { IOSEpicCopy.clock($0.epic, now: now) }, digest.flatMap(IOSEpicCopy.stage)]
            .compactMap { $0 }.joined(separator: ", ")
    }
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `native/scripts/uitest-lock.sh native/scripts/test-ios-app.sh unit`
Expected: PASS; the existing `testRenderDarkEpicListSection` still compiles with the old call.

- [ ] **Step 8: Commit**

```bash
git add native/Apps/ShepherdIOS/Sources/Sessions/SessionListStyle.swift native/Apps/ShepherdIOS/Sources/Sessions/IOSEpicCopy.swift native/Apps/ShepherdIOS/Sources/Sessions/IOSEpicViews.swift native/Apps/ShepherdIOS/Sources/Sessions/IOSEpicGroupHeader.swift native/Apps/ShepherdIOS/Tests/IOSEpicGroupingTests.swift
git commit -m "feat(ios): draw the epic group header in blue with progress, status and cues"
```

---

### Task 9: iOS — chain strip on the session card

**Files:**
- Create: `native/Apps/ShepherdIOS/Sources/Sessions/IOSEpicChainStrip.swift`
- Modify: `native/Apps/ShepherdIOS/Sources/Sessions/SessionCardView.swift`
- Test: `native/Apps/ShepherdIOS/Tests/IOSEpicGroupingTests.swift`

**Interfaces:**
- Consumes: `EpicChain`, `EpicText.numbers` (Task 3), keys (Task 5).
- Produces: `IOSEpicChainStrip(chain:)` with `static func accessibilityText(_ chain: EpicChain)
  -> String`; `SessionCardView(card:selected:serverName:rowID:chain:select:)` (`chain` defaults to
  nil).

- [ ] **Step 1: Write the failing test** (add to `IOSEpicGroupingTests`):

```swift
    func testChainStripReadsAsOneSentence() throws {
        let epic = try JSONDecoder().decode(Epic.self, from: Data(#"""
            {"repoPath":"/repos/app","parentIssueNumber":100,"parentTitle":"Epic: Ship","source":"native",
            "children":[
            {"number":101,"title":"A","url":"https://x/101","order":0,"body":"","blockedBy":[],"state":"running","sessionId":"a","prNumber":null,"issueClosed":false,"integrationMerged":false,"claimed":true},
            {"number":102,"title":"B","url":"https://x/102","order":1,"body":"","blockedBy":[101],"state":"blocked","sessionId":null,"prNumber":null,"issueClosed":false,"integrationMerged":false,"claimed":false},
            {"number":103,"title":"C","url":"https://x/103","order":2,"body":"","blockedBy":[101],"state":"blocked","sessionId":null,"prNumber":null,"issueClosed":false,"integrationMerged":false,"claimed":false}],
            "warnings":[],"run":{"repoPath":"/repos/app","parentIssueNumber":100,"mode":"auto","status":"running"}}
            """#.utf8))
        let chain = try XCTUnwrap(EpicDigest(epic).chain(101))
        XCTAssertEqual(IOSEpicChainStrip.accessibilityText(chain), L.t("native_ios_epic_chain_aria",
            L.t("native_ios_epic_needs_none"), "1", "2", "101",
            "#102, #103, " + L.t("native_ios_epic_parallel", "2")))
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `native/scripts/uitest-lock.sh native/scripts/test-ios-app.sh unit`
Expected: build failure, `cannot find 'IOSEpicChainStrip' in scope`.

- [ ] **Step 3: Create `IOSEpicChainStrip.swift`**

```swift
import SwiftUI
import ShepherdAppCore
import ShepherdKit

/// "BRAUCHT → STUFE s/S → GIBT FREI" under an epic member's card: the web's
/// "Braucht zuerst → Dieses Issue → Gibt frei", condensed to one strip.
struct IOSEpicChainStrip: View {
    let chain: EpicChain

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            column(L.t("native_ios_epic_needs")) { needs }
                .frame(maxWidth: .infinity, alignment: .leading)
            arrow
            column(L.t("native_ios_epic_stage", String(chain.stage), String(chain.stageCount)),
                   tint: SessionListStyle.blue) {
                Text(verbatim: "#\(chain.number)").fontWeight(.semibold).foregroundStyle(SessionListStyle.bright)
            }
            .fixedSize()
            arrow
            column(L.t("childrun_step_unlocks")) { unlocks }
                .frame(maxWidth: .infinity, alignment: .leading)
                .layoutPriority(1)
        }
        .padding(.top, 8)
        .overlay(alignment: .top) {
            HLine().stroke(SessionListStyle.epicRail, style: StrokeStyle(lineWidth: 1, dash: [3, 3])).frame(height: 1)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: Self.accessibilityText(chain)))
        .accessibilityIdentifier("epic-chain-\(chain.number)")
    }

    private var arrow: some View {
        Image(systemName: "arrow.right").sessionFont(label: true)
            .foregroundStyle(SessionListStyle.blue).padding(.top, 14).accessibilityHidden(true)
    }

    private func column<Content: View>(_ label: String, tint: Color = SessionListStyle.muted,
                                       @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(verbatim: label.uppercased()).sessionFont(label: true, weight: .medium).tracking(0.8)
                .foregroundStyle(tint).lineLimit(1)
            content().sessionFont(label: true)
        }
    }

    @ViewBuilder private var needs: some View {
        let open = chain.needs.filter { !$0.merged }.map(\.number)
        if chain.needs.isEmpty {
            Text(verbatim: L.t("native_ios_epic_needs_none")).foregroundStyle(SessionListStyle.muted)
        } else if !open.isEmpty {
            // Started out of order: a blocker is still open.
            Label { Text(verbatim: L.t("native_ios_epic_need_open", EpicText.numbers(open))) }
                icon: { Image(systemName: "exclamationmark.triangle") }
                .labelStyle(.titleAndIcon).foregroundStyle(SessionListStyle.amber)
        } else {
            Text(verbatim: EpicText.numbers(chain.needs.map(\.number), prefix: "✓ ")).foregroundStyle(SessionListStyle.muted)
        }
    }

    @ViewBuilder private var unlocks: some View {
        if chain.unlocks.isEmpty {
            Text(verbatim: L.t("native_ios_epic_unlocks_none")).foregroundStyle(SessionListStyle.muted)
            if chain.isLast {
                Text(verbatim: L.t("native_ios_epic_lands_next")).foregroundStyle(SessionListStyle.muted)
            }
        } else {
            Text(verbatim: EpicText.numbers(chain.unlocks)).foregroundStyle(SessionListStyle.ink)
            if chain.parallel >= 2 {
                Text(verbatim: L.t("native_ios_epic_parallel", String(chain.parallel))).foregroundStyle(SessionListStyle.muted)
            }
        }
    }

    static func accessibilityText(_ chain: EpicChain) -> String {
        let needs = chain.needs.isEmpty ? L.t("native_ios_epic_needs_none")
            : chain.needs.map { $0.merged ? "✓ #\($0.number)" : L.t("native_ios_epic_need_open", "#\($0.number)") }
                .joined(separator: ", ")
        var unlocks = chain.unlocks.isEmpty ? L.t("native_ios_epic_unlocks_none")
            : chain.unlocks.map { "#\($0)" }.joined(separator: ", ")
        if chain.parallel >= 2 { unlocks += ", " + L.t("native_ios_epic_parallel", String(chain.parallel)) }
        return L.t("native_ios_epic_chain_aria", needs, String(chain.stage), String(chain.stageCount),
            String(chain.number), unlocks)
    }
}

private struct HLine: Shape {
    func path(in rect: CGRect) -> Path {
        Path { path in
            path.move(to: CGPoint(x: rect.minX, y: rect.midY))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        }
    }
}
```

- [ ] **Step 4: Show it on the card** — in `SessionCardView`:

Add the property after `var rowID: String?`:

```swift
    /// The member's place in its epic; nil outside an epic group or before the epic loaded.
    var chain: EpicChain? = nil
```

In `body`, between the heartbeat line and the `ViewThatFits` metadata block:

```swift
                if let chain {
                    IOSEpicChainStrip(chain: chain)
                        .padding(.leading, typeSize.isAccessibilitySize ? 0 : 22)
                }
```

In `accessibilityLabel`, add as the last array element (before `.filter`):

```swift
         chain.map(IOSEpicChainStrip.accessibilityText) ?? ""]
```

(that is: replace the closing `]` of the array literal after the heartbeat entry with `,` plus
this line).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `native/scripts/uitest-lock.sh native/scripts/test-ios-app.sh unit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add native/Apps/ShepherdIOS/Sources/Sessions/IOSEpicChainStrip.swift native/Apps/ShepherdIOS/Sources/Sessions/SessionCardView.swift native/Apps/ShepherdIOS/Tests/IOSEpicGroupingTests.swift
git commit -m "feat(ios): show an epic member's predecessors and successors on its card"
```

---

### Task 10: iOS — fold row and epic sheet

**Files:**
- Create: `native/Apps/ShepherdIOS/Sources/Sessions/IOSEpicFoldRow.swift`
- Create: `native/Apps/ShepherdIOS/Sources/Sessions/IOSEpicSheet.swift`

**Interfaces:**
- Consumes: `EpicFold`, `EpicDigest`, `EpicText` (Tasks 3–4), `IOSEpicStateDot`, `IOSEpicMeter`,
  `IOSEpicRunChip`, `IOSEpicCopy` (Task 8).
- Produces: `IOSEpicFoldRow(fold:parent:expanded:toggle:open:)`;
  `IOSEpicSheet(group:digest:now:session:)` where `session: (EpicChild) -> (() -> Void)?` returns
  the action that opens a child's session, or nil when the group lists none.

These are views without logic of their own (every rule is in AppCore and tested there); they are
verified by the render test in Task 11 and on the device.

- [ ] **Step 1: Create `IOSEpicFoldRow.swift`**

```swift
import SwiftUI
import ShepherdAppCore
import ShepherdKit

/// "WEITERE SCHRITTE (n)": the epic's children without a session, folded into one row; expanded,
/// they list by stage. A child opens the epic sheet.
struct IOSEpicFoldRow: View {
    let fold: EpicFold
    let parent: Int
    let expanded: Bool
    let toggle: () -> Void
    let open: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Button(action: toggle) {
                HStack(spacing: 8) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right").frame(width: 12)
                    Text(verbatim: L.t("native_ios_epic_more_steps", String(fold.count)).uppercased())
                        .tracking(0.8).lineLimit(1)
                    Spacer(minLength: 6)
                    if let summaryText { Text(verbatim: summaryText).lineLimit(1) }
                }
                .padding(.horizontal, 12)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .overlay { Rectangle().stroke(SessionListStyle.brightLine, style: StrokeStyle(lineWidth: 1, dash: [4, 3])) }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(Text(verbatim: L.t(expanded ? "native_ios_group_expanded" : "native_ios_group_collapsed")))
            .accessibilityIdentifier("epic-fold-\(parent)")
            if expanded {
                ForEach(fold.stages, id: \.index) { stage in
                    Text(verbatim: stageLabel(stage).uppercased()).tracking(0.8)
                        .padding(.top, 8).padding(.bottom, 2)
                        .accessibilityAddTraits(.isHeader)
                    ForEach(stage.items, id: \.child.number) { item in
                        Button(action: open) { itemRow(item) }.buttonStyle(.plain)
                    }
                }
            }
        }
        .sessionFont(label: true)
        .foregroundStyle(SessionListStyle.muted)
    }

    private var summaryText: String? {
        switch fold.summary {
        case .ready(let count): L.t("native_ios_epic_fold_ready", String(count))
        case .waiting(let on): L.t("native_ios_epic_fold_next_after", EpicText.numbers(on))
        case nil: nil
        }
    }

    private func stageLabel(_ stage: EpicFold.Stage) -> String {
        stage.after.isEmpty ? L.t("native_ios_epic_stage_only", String(stage.index))
            : L.t("native_ios_epic_stage_after", String(stage.index), EpicText.numbers(stage.after))
    }

    private func itemRow(_ item: EpicFold.Item) -> some View {
        HStack(spacing: 9) {
            IOSEpicStateDot(tone: IOSEpicStateDot.tone(item.child))
            Text(verbatim: "#\(item.child.number)").foregroundStyle(SessionListStyle.bright)
            Text(verbatim: EpicText.stepTitle(item.child.title, parent: parent))
                .lineLimit(1).truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            if item.unlocks > 0 {
                Text(verbatim: L.t("native_ios_epic_frees", String(item.unlocks))).fixedSize()
            }
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }
}
```

- [ ] **Step 2: Create `IOSEpicSheet.swift`**

```swift
import SwiftUI
import ShepherdAppCore
import ShepherdKit

/// The epic sheet behind the EPIC badge: progress, clock and forecast, what runs now, and the
/// whole flow by stage. It only shows; controlling an epic stays in the browser.
struct IOSEpicSheet: View {
    let group: IOSMergedSessionPresentation.EpicGroup
    let digest: EpicDigest
    let now: Int
    /// The action that opens a child's session, or nil when this group lists none for it.
    let session: (EpicChild) -> (() -> Void)?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    private var parent: Int { digest.epic.parentIssueNumber }
    private var running: [EpicChild] {
        digest.epic.children.filter(\.isInFlight).sorted { $0.order < $1.order }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    head
                    progress
                    if !running.isEmpty { nowSection }
                    flowSection
                    footer
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(SessionListStyle.panel)
            .navigationTitle(Text(verbatim: "EPIC #\(parent)"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button(L.t("common_close")) { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
        .preferredColorScheme(.dark)
        .accessibilityIdentifier("epic-sheet-\(group.parentNumber)")
    }

    private var head: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: group.repoName).sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
            Text(verbatim: EpicText.displayTitle(digest.epic.parentTitle)).sessionFont(weight: .semibold)
                .foregroundStyle(SessionListStyle.bright).fixedSize(horizontal: false, vertical: true)
            if let chip = IOSEpicCopy.runChip(digest.epic) { IOSEpicRunChip(text: chip).sessionFont(label: true) }
        }
    }

    private var progress: some View {
        VStack(alignment: .leading, spacing: 7) {
            IOSEpicMeter(tones: digest.meter, height: 4, spacing: 3)
            Text(verbatim: [L.t("epicflow_merged", String(digest.merged), String(digest.total)),
                            digest.inFlight > 0 ? L.t("native_ios_epic_in_flight", String(digest.inFlight)) : nil]
                .compactMap { $0 }.joined(separator: " · "))
                .foregroundStyle(SessionListStyle.ink)
            let clock = [IOSEpicCopy.clock(digest.epic, now: now), IOSEpicCopy.forecast(digest.epic)].compactMap { $0 }
            if !clock.isEmpty {
                Text(verbatim: clock.joined(separator: " · ")).foregroundStyle(SessionListStyle.muted)
            }
        }
        .sessionFont(label: true)
    }

    private var nowSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionLabel(L.t("native_ios_epic_now"))
            ForEach(running, id: \.number) { child in
                childButton(child) { nowRow(child) }
            }
        }
    }

    private func nowRow(_ child: EpicChild) -> some View {
        HStack(spacing: 10) {
            IOSEpicStateDot(tone: .active)
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    Text(verbatim: "#\(child.number)").foregroundStyle(SessionListStyle.bright)
                    Text(verbatim: EpicText.stepTitle(child.title, parent: parent)).lineLimit(1)
                }
                HStack(spacing: 6) {
                    if let pr = child.prNumber {
                        Text(verbatim: "PR #\(pr)").padding(.horizontal, 5).padding(.vertical, 1)
                            .overlay { RoundedRectangle(cornerRadius: 2).stroke(SessionListStyle.brightLine, lineWidth: 1) }
                    }
                    Text(verbatim: stateWord(child)).foregroundStyle(SessionListStyle.amber)
                }
                .foregroundStyle(SessionListStyle.muted)
            }
            Spacer(minLength: 0)
            if session(child) != nil {
                Image(systemName: "chevron.right").foregroundStyle(SessionListStyle.muted).accessibilityHidden(true)
            }
        }
        .sessionFont(label: true)
        .padding(10)
        .frame(minHeight: 52)
        .background(SessionListStyle.background)
        .overlay { Rectangle().stroke(SessionListStyle.line, lineWidth: 1) }
    }

    private var flowSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            sectionLabel(L.t("epicflow_title"))
            ForEach(digest.flow.stages, id: \.index) { stage in
                HStack(spacing: 8) {
                    Text(verbatim: stageTitle(stage).uppercased()).tracking(0.8)
                    Spacer(minLength: 6)
                    let after = Set(stage.children.flatMap { digest.flow.blockers[$0.number] ?? [] }).sorted()
                    if !after.isEmpty { Text(verbatim: L.t("native_ios_epic_after", EpicText.numbers(after))) }
                }
                .sessionFont(label: true, weight: .medium)
                .foregroundStyle(SessionListStyle.muted)
                .padding(.top, 6)
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isHeader)
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(stage.children, id: \.number) { child in
                        childButton(child) { nodeRow(child) }
                    }
                }
                .padding(.leading, 18)
                .overlay(alignment: .leading) {
                    if stage.index < digest.flow.stages.count {
                        Rectangle().fill(SessionListStyle.brightLine).frame(width: 1).padding(.leading, 3)
                    }
                }
            }
            SessionWrappingLayout(spacing: 12) {
                legendItem(.active, "epicflow_legend_active")
                legendItem(.ready, "epicflow_legend_ready")
                legendItem(.waiting, "epicflow_legend_waiting")
                legendItem(.merged, "epicflow_legend_merged")
            }
            .padding(.top, 6)
            if let stage = digest.flow.firstParallelStage {
                Text(verbatim: L.t("native_ios_epic_slots_hint", String(stage)))
                    .sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
            }
        }
    }

    private func nodeRow(_ child: EpicChild) -> some View {
        HStack(spacing: 9) {
            IOSEpicStateDot(tone: IOSEpicStateDot.tone(child))
            Text(verbatim: "#\(child.number)").foregroundStyle(SessionListStyle.bright)
            Text(verbatim: EpicText.stepTitle(child.title, parent: parent))
                .foregroundStyle(child.isMerged ? SessionListStyle.muted : SessionListStyle.ink)
                .lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
            if child.isInFlight {
                Text(verbatim: stateWord(child)).foregroundStyle(SessionListStyle.amber).fixedSize()
            } else if !child.isMerged, let unlocks = digest.chain(child.number)?.unlocks.count, unlocks > 0 {
                Text(verbatim: L.t("native_ios_epic_frees", String(unlocks))).foregroundStyle(SessionListStyle.muted).fixedSize()
            }
        }
        .sessionFont(label: true)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }

    private var footer: some View {
        Button { openURL(group.profile.baseURL) } label: {
            Label(L.t("native_ios_epic_open_web"), systemImage: "arrow.up.right.square")
                .sessionFont(label: true)
                .frame(maxWidth: .infinity, minHeight: 44)
                .overlay { Rectangle().stroke(SessionListStyle.brightLine, lineWidth: 1) }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(SessionListStyle.ink)
        .accessibilityIdentifier("epic-open-web")
    }

    @ViewBuilder
    private func childButton<Content: View>(_ child: EpicChild, @ViewBuilder label: () -> Content) -> some View {
        if let action = session(child) {
            Button { action(); dismiss() } label: { label() }.buttonStyle(.plain)
        } else {
            label()
        }
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(verbatim: text.uppercased()).sessionFont(label: true, weight: .medium).tracking(0.8)
            .foregroundStyle(SessionListStyle.muted).accessibilityAddTraits(.isHeader)
    }

    private func legendItem(_ tone: IOSEpicDotTone, _ key: StaticString) -> some View {
        HStack(spacing: 5) { IOSEpicStateDot(tone: tone); Text(verbatim: L.t(key)) }
            .sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
    }

    private func stageTitle(_ stage: EpicFlow.Stage) -> String {
        if stage.index == 1 { return L.t("epicflow_stage_first") }
        return stage.parallel ? L.t("epicflow_stage_parallel", String(stage.index)) : String(stage.index)
    }

    private func stateWord(_ child: EpicChild) -> String {
        L.t(child.state.rawValue == "in-review" ? "epic_state_in_review" : "epic_state_running")
    }
}
```

- [ ] **Step 3: Build**

Run: `native/scripts/uitest-lock.sh native/scripts/build-ios-app.sh Debug`
Expected: build succeeds (the views are not wired yet).

- [ ] **Step 4: Commit**

```bash
git add native/Apps/ShepherdIOS/Sources/Sessions/IOSEpicFoldRow.swift native/Apps/ShepherdIOS/Sources/Sessions/IOSEpicSheet.swift
git commit -m "feat(ios): add the epic fold row and the epic sheet"
```

---

### Task 11: iOS — wire the list, then verify

**Files:**
- Modify: `native/Apps/ShepherdIOS/Sources/Sessions/SessionListView.swift`
- Modify: `native/Apps/ShepherdIOS/Tests/IOSEpicGroupingTests.swift` (strings, render)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Extend the strings test** — in `testEpicStringsResolveInBothLocales`, replace the
  key list with:

```swift
            for key in ["epic_badge", "epic_group_collapse_aria", "epic_group_expand_aria", "upnext_pill_epic",
                        "epic_role_leading", "epic_group_cue_ready", "epicflow_title", "epicflow_merged",
                        "childrun_step_unlocks", "native_ios_epic_needs", "native_ios_epic_stage",
                        "native_ios_epic_more_steps", "native_ios_epic_fold_next_after", "native_ios_epic_open_aria",
                        "native_ios_epic_chain_aria", "native_ios_epic_slots_hint", "native_ios_epic_open_web"] {
```

- [ ] **Step 2: Render the new section** — in `testRenderDarkEpicListSection`, give the first
  group a digest so the header, chain strip and fold row render:

Before `let content = List {`:

```swift
        let epic = try JSONDecoder().decode(Epic.self, from: Data(#"""
            {"repoPath":"/repos/app","parentIssueNumber":100,"parentTitle":"Epic: Ship epic grouping","source":"native",
            "children":[
            {"number":101,"title":"First","url":"https://x/101","order":0,"body":"","blockedBy":[],"state":"running","sessionId":"01","prNumber":112,"issueClosed":false,"integrationMerged":false,"claimed":true},
            {"number":102,"title":"Second","url":"https://x/102","order":1,"body":"","blockedBy":[101],"state":"blocked","sessionId":null,"prNumber":null,"issueClosed":false,"integrationMerged":false,"claimed":false},
            {"number":103,"title":"Third","url":"https://x/103","order":2,"body":"","blockedBy":[101],"state":"blocked","sessionId":null,"prNumber":null,"issueClosed":false,"integrationMerged":false,"claimed":false}],
            "warnings":[],"run":{"repoPath":"/repos/app","parentIssueNumber":100,"mode":"auto","status":"running"}}
            """#.utf8))
        let digest = EpicDigest(epic)
```

Replace the header and card lines inside `ForEach(result.epicGroups)` with:

```swift
                IOSEpicGroupHeader(group: group, summary: group.parentNumber == 100 ? summary : nil,
                    digest: group.parentNumber == 100 ? digest : nil, collapsed: false, toggle: {}, open: {})
                ForEach(group.rows) { row in
                    SessionCardView(card: IOSSessionListPresentation.card(row.session, displayed: row.session, now: 0),
                        chain: group.parentNumber == 100 ? digest.chain(101) : nil, select: {})
                        .listRowInsets(EdgeInsets(top: 0, leading: 22, bottom: 0, trailing: 10))
                        .listRowBackground(IOSEpicRailBackground()).listRowSeparator(.hidden)
                }
                if group.parentNumber == 100 {
                    IOSEpicFoldRow(fold: digest.fold(shown: [101]), parent: 100, expanded: true, toggle: {}, open: {})
                        .listRowInsets(EdgeInsets(top: 0, leading: 22, bottom: 0, trailing: 10))
                        .listRowBackground(IOSEpicRailBackground()).listRowSeparator(.hidden)
                }
```

and raise the render height so the fold row fits: `let size = CGSize(width: 390, height: 844)`.

The test writes its PNG to a hard-coded `/private/tmp/claude-501/…/scratchpad/render/` path from
an earlier session. Replace that `directory` line with a path the current run can find:

```swift
        let directory = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("render")
        print("epic render: \(directory.appendingPathComponent("epic-session-list-dark.png").path)")
```

- [ ] **Step 3: Wire `SessionListView`**

Add state next to `collapsedEpics`:

```swift
    @State private var expandedFolds: Set<String> = []
    @State private var epicSheet: IOSMergedSessionPresentation.EpicGroup?
```

Add the sheet next to the other `.sheet` modifiers in `body`:

```swift
        .sheet(item: $epicSheet) { group in
            if let digest = epicDirectory.digest(group, owner: hub?.models[group.profile.id] ?? app) {
                TimelineView(.periodic(from: .now, by: 20)) { context in
                    IOSEpicSheet(group: group, digest: digest, now: Int(context.date.timeIntervalSince1970 * 1_000)) { child in
                        guard let row = group.rows.first(where: { row in
                            child.sessionId.map { $0 == row.session.id } ?? (row.session.issueNumber == child.number)
                        }) else { return nil }
                        return { selectRow(row.id) }
                    }
                }
            }
        }
```

Include each group's fingerprint in the load identity:

```swift
    private var epicLoadIdentity: [String] {
        presentation.epicGroups.map { group in
            let owner = hub?.models[group.profile.id] ?? app
            return "\(group.id):\(ObjectIdentifier(owner)):\(owner.activationGeneration):\(group.fingerprint)"
        }
    }
```

Replace the `ForEach(snapshot.epicGroups) { group in … }` block in `content(now:)` with:

```swift
                    ForEach(snapshot.epicGroups) { group in
                        let owner = hub?.models[group.profile.id] ?? app
                        let digest = epicDirectory.digest(group, owner: owner)
                        IOSEpicGroupHeader(group: group, summary: epicDirectory.summary(group, owner: owner),
                            digest: digest, collapsed: collapsedEpics.contains(group.id), now: now,
                            toggle: { if !collapsedEpics.insert(group.id).inserted { collapsedEpics.remove(group.id) } },
                            open: digest == nil ? nil : { epicSheet = group })
                        if !collapsedEpics.contains(group.id) {
                            ForEach(group.rows) { row in
                                card(row, showCli: showCli, now: now, leading: 22, inEpic: true, chain: chain(row, digest))
                            }
                            if let digest {
                                let fold = digest.fold(shown: Set(group.rows.compactMap {
                                    digest.child(session: $0.session.id, issue: $0.session.issueNumber)?.number
                                }))
                                if fold.count > 0 {
                                    IOSEpicFoldRow(fold: fold, parent: group.parentNumber,
                                        expanded: expandedFolds.contains(group.id),
                                        toggle: { if !expandedFolds.insert(group.id).inserted { expandedFolds.remove(group.id) } },
                                        open: { epicSheet = group })
                                        .listRowInsets(EdgeInsets(top: 0, leading: 22, bottom: 0, trailing: 10))
                                        .listRowBackground(IOSEpicRailBackground()).listRowSeparator(.hidden)
                                }
                            }
                        }
                    }
```

Change `card(…)`: add the parameters and pass them on.

```swift
    private func card(_ row: IOSMergedSessionPresentation.Row, showCli: Bool, now: Int, leading: CGFloat = 10,
                      inEpic: Bool = false, chain: EpicChain? = nil) -> some View {
```

In its `return SessionCardView(…)` call add `chain: chain,` after the `rowID:` argument, and
replace `.listRowBackground(SessionListStyle.background)` in `card(…)` with
`.listRowBackground(IOSEpicRailBackground(rail: inEpic))`.

Add the helper next to `owner(for:)`:

```swift
    private func chain(_ row: IOSMergedSessionPresentation.Row, _ digest: EpicDigest?) -> EpicChain? {
        guard let digest, let child = digest.child(session: row.session.id, issue: row.session.issueNumber) else { return nil }
        return digest.chain(child.number)
    }
```

- [ ] **Step 4: Run every gate**

From the repository root on the Mac:

```bash
swift build --package-path native
swift test --package-path native
native/scripts/uitest-lock.sh native/scripts/test-ios-app.sh unit
native/scripts/uitest-lock.sh native/scripts/test-ios-app.sh ui --family iPhone
bun native/scripts/gen-strings.ts --check
(cd ui && bun run check:i18n)
```

Expected: all pass. Open the PNG path the render test printed and compare it with the design
canvas: blue header with `EPIC 0/3` and meter, the chain strip on the card, the expanded fold
row with "Stufe 2 · nach #101".

- [ ] **Step 5: Commit**

```bash
git add native/Apps/ShepherdIOS/Sources/Sessions/SessionListView.swift native/Apps/ShepherdIOS/Tests/IOSEpicGroupingTests.swift
git commit -m "feat(ios): wire epic chains, the fold row and the epic sheet into the session list"
```

---

### Task 12: Pull request and the build on the phone

- [ ] **Step 1: Try it on the iPhone first (Shepherd Dev)**

With the iPhone paired in DeviceHub.app:

```bash
native/scripts/uitest-lock.sh native/scripts/ios-device.sh
```

Check against a server with a running epic (for example #111 in media-bib-and-rendering): blue
header with meter, status line and cues; the chain strip on the epic card; "Weitere Schritte"
folds and unfolds; the EPIC badge opens the sheet; a child with a session opens that session;
"Im Browser öffnen" opens the web UI.

- [ ] **Step 2: Open the pull request**

Load the `shepherd-pull-requests` skill first; one PR for this work. Rebase onto `origin/main`
if needed (never merge `main` into the branch). Title:
`feat(ios): show epics with their chain in the session list`. The body links the spec, this plan
and the design canvas, and lists the gates from Task 11 Step 4 with their results.

- [ ] **Step 3: TestFlight preview with release notes**

Follow `native/docs/testflight-ios.md`. Dispatch a preview of the branch (it uploads
`<count>.<run number>`):

```bash
gh workflow run native-ios-testflight.yml --ref <branch> -f ref=<branch> -f dry_run=false
```

Poll at most once every three minutes (`gh api repos/erwins-enkel/shepherd/actions/runs/RUN_ID`).
After App Store Connect processed the build, save **What to Test** on exactly that version/build
and verify it is readable in the TestFlight app. Draft:

```
Build <version> (<build>) — Epics in der Sitzungsliste

Neu:
- Epics sind in der Liste jetzt blau abgesetzt: Kopf mit Fortschrittsbalken (ein Segment pro
  Kind), Status (führt/pausiert), Laufzeit, Stufe und Signal-Chips.
- Jede Epic-Karte zeigt ihre Kette: Braucht → Stufe → Gibt frei.
- "Weitere Schritte" fasst die Kinder ohne Sitzung zusammen; aufgeklappt nach Stufen.
- Tipp auf das EPIC-Badge öffnet das Epic-Sheet mit Fortschritt, Prognose, "Jetzt" und dem
  ganzen Ablauf.

Bitte testen:
- Ein laufendes Epic öffnen, die Kette auf der Karte mit dem Web vergleichen.
- Weitere Schritte auf- und zuklappen; ein Kind antippen öffnet das Sheet.
- Im Sheet ein laufendes Kind antippen: die Sitzung öffnet sich.

Bekannt: Steuern (starten, pausieren, freigeben) bleibt im Browser.
```

The release is complete only once the notes are saved on the matching build.
