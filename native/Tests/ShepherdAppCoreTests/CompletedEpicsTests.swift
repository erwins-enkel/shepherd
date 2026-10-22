import Foundation
import Testing
import ShepherdKit
@testable import ShepherdAppCore

/// Completed epics the way GET /api/epics/completed answers them. `fields` overrides or adds
/// top-level keys; a `nil` value removes one.
enum CompletedEpicFixtures {
    static let children: [[String: Any]] = [
        ["number": 5, "title": "angebote: Datenmodell und Migrationen",
         "url": "https://github.com/acme/widgets/issues/5", "prNumber": 20,
         "prUrl": "https://github.com/acme/widgets/pull/20", "mergedAt": 1_800_000_000_000, "integrated": true],
        ["number": 4, "title": "#4", "url": "https://github.com/acme/widgets/issues/4",
         "prNumber": NSNull(), "prUrl": NSNull(), "mergedAt": NSNull(), "integrated": false],
    ]

    static func epic(parent: Int = 15, _ fields: [String: Any?] = [:]) throws -> CompletedEpic {
        var json: [String: Any] = [
            "repoPath": "/repos/eemockup", "parentIssueNumber": parent,
            "parentTitle": "Epic: Angebotskalkulator und Mockup-Modul",
            "completedAt": 1_800_000_000_000, "children": children,
            "integrationBranch": "epic/15-angebotskalkulator",
            "landingPrNumber": 29, "landingPrUrl": "https://github.com/acme/widgets/pull/29",
            "landingState": "open", "migrationPaths": [String](), "migrationsAckedAt": NSNull(),
            "landingRebasePauseReason": NSNull(), "landingRepairCount": 0,
            "landingRepairHead": NSNull(), "landingConflictReworkCount": 0,
        ]
        for (key, value) in fields { json[key] = value }
        return try JSONDecoder().decode(CompletedEpic.self, from: JSONSerialization.data(withJSONObject: json))
    }

    static func automation(reruns: String, repair: String, rerunSkip: String? = nil,
                           repairSkip: String? = nil, session: String? = nil) -> [String: Any] {
        func value(_ text: String?) -> Any { text.map { $0 as Any } ?? NSNull() }
        return [
            "reruns": ["status": reruns, "used": 1, "cap": 1, "skipReason": value(rerunSkip)],
            "repair": ["status": repair, "used": 0, "cap": 1, "skipReason": value(repairSkip),
                       "sessionId": value(session), "sessionStartedAt": NSNull()],
        ]
    }
}

extension CoreSeamTests {
@MainActor
struct CompletedEpicStatusTests {
    private typealias F = CompletedEpicFixtures

    @Test func everyLandingStateMapsToTheWebsSituation() throws {
        let cases: [([String: Any?], Bool, CompletedEpicSituation, CompletedEpicTurn, CompletedEpicTone)] = [
            (["landingState": "pending", "landingPrNumber": NSNull()], false, .preparing, .nothingToDo, .quiet),
            (["landingChecks": "pending", "landingMergeable": true], false, .checking, .nothingToDo, .quiet),
            (["landingRepairing": true, "landingMergeable": false], false, .repairing, .nothingToDo, .quiet),
            (["landingChecks": "failure", "landingMergeable": true,
              "landingCiAutomation": F.automation(reruns: "running", repair: "pending")],
             false, .ciRetrying, .nothingToDo, .quiet),
            (["landingChecks": "failure", "landingMergeable": true,
              "landingCiAutomation": F.automation(reruns: "done", repair: "done")],
             false, .ciFailed, .yourTurn, .warn),
            (["landingMergeable": false], false, .conflicts, .yourTurn, .warn),
            (["landingState": "none"], false, .nothingToLand, .yourTurn, .warn),
            (["landingChecks": "success", "landingMergeable": true, "landingReady": true],
             false, .ready, .ready, .ready),
            (["landingChecks": "success", "landingMergeable": true, "landingReady": true],
             true, .landing, .nothingToDo, .quiet),
            (["landingState": "merged"], false, .landed, .done, .quiet),
            (["landingState": "error", "landingPrNumber": NSNull()], false, .error, .yourTurn, .warn),
            (["landingChecks": "success", "landingMergeable": true, "landingReady": false],
             false, .notReady, .yourTurn, .warn),
        ]
        for (fields, landing, situation, turn, tone) in cases {
            let status = CompletedEpicStatus(try F.epic(fields), landing: landing)
            #expect(status.situation == situation, "\(fields)")
            #expect(status.turn == turn, "\(fields)")
            #expect(status.tone == tone, "\(fields)")
            #expect(status.needsOperator == (turn == .yourTurn || turn == .ready), "\(fields)")
        }
    }

    @Test func onlyAReadyRowCanLand() throws {
        let ready = try F.epic(["landingChecks": "success", "landingMergeable": true, "landingReady": true])
        #expect(CompletedEpicStatus(ready).canLand)
        // Ready needs the landing PR's number as well as the server's word.
        let noNumber = try F.epic(["landingReady": true, "landingPrNumber": NSNull()])
        #expect(!CompletedEpicStatus(noNumber).canLand)
        #expect(!CompletedEpicStatus(try F.epic(["landingState": "merged"])).canLand)
    }

    @Test func redCiOffersTheRepairAgentOnlyOnGitHub() throws {
        let red = try F.epic(["landingChecks": "failure", "landingMergeable": true,
            "landingCiAutomation": F.automation(reruns: "done", repair: "skipped", repairSkip: "auto-drain-off")])
        let status = CompletedEpicStatus(red)
        #expect(status.canRepairCi)
        #expect(status.ciVariant == .drainOff)
        let gitea = try F.epic(["landingChecks": "failure", "landingMergeable": true,
            "landingCiAutomation": F.automation(reruns: "skipped", repair: "skipped",
                rerunSkip: "no-github", repairSkip: "no-github")])
        #expect(!CompletedEpicStatus(gitea).canRepairCi)
        #expect(CompletedEpicStatus(gitea).ciVariant == .unsupported)
    }

    @Test func aRebasePauseIsAConflictOnlyTheConflictReasonLetsTheOperatorResolve() throws {
        let conflict = CompletedEpicStatus(try F.epic(["landingRebasePauseReason": "conflict"]))
        #expect(conflict.situation == .conflicts)
        #expect(conflict.canResolveConflicts)
        let cap = CompletedEpicStatus(try F.epic(["landingRebasePauseReason": "cap"]))
        #expect(cap.situation == .conflicts)
        #expect(!cap.canResolveConflicts)
    }

    @Test func anUnknownLandingStateClaimsNothing() throws {
        let status = CompletedEpicStatus(try F.epic(["landingState": "rebasing"]))
        #expect(status.situation == .checking)
        #expect(!status.needsOperator)
    }
}

@MainActor
struct CompletedEpicCardTests {
    private typealias F = CompletedEpicFixtures
    private let now = 1_800_000_000_000 + 12 * 60_000

    @Test func aReadyCardLandsWithAConfirmationThatWarnsAboutMigrations() throws {
        let epic = try F.epic(["landingChecks": "success", "landingMergeable": true, "landingReady": true,
            "migrationPaths": ["packages/angebote/migrations/001.sql", "packages/mockups/migrations/001.sql"]])
        let card = CompletedEpicCard(epic, now: now)
        #expect(card.buttons.map(\.action) == [.land])
        #expect(card.buttons.first?.prominent == true)
        #expect(card.lockedReason == nil)
        #expect(card.showsFooter)
        #expect(card.finished == L.t("integrated_epics_finished_ago", "12m"))
        let confirmation = try #require(card.confirmation)
        #expect(confirmation.prompt == L.t("integrated_epics_land_confirm_prompt", "29"))
        #expect(confirmation.message == L.t("integrated_epics_land_confirm_body", "1", "15"))
        #expect(confirmation.migrationWarning == L.t("integrated_epics_land_confirm_migration_warn", "2"))
        // The web marks glossary terms; the native card reads them as their label.
        #expect(!card.body.contains("[["))
        #expect(card.steps.map(\.marker) == [.done, .done, .ready, .open])
    }

    @Test func aLockedLandNamesItsReason() throws {
        let epic = try F.epic(["landingChecks": "failure", "landingMergeable": true,
            "landingCiAutomation": F.automation(reruns: "done", repair: "done", session: "sess_repair")])
        let card = CompletedEpicCard(epic, now: now)
        #expect(card.lockedReason == L.t("integrated_epics_land_not_ready_ci_failing"))
        #expect(card.heading == L.t("integrated_epics_heading_ci_after_repair"))
        let checks = try #require(URL(string: "https://github.com/acme/widgets/pull/29/checks"))
        #expect(card.buttons.map(\.action) == [.repairCi, .openSession("sess_repair"), .openURL(checks)])
        #expect(card.buttons.map(\.label).first == L.t("integrated_epics_repair_ci_again"))
        #expect(card.notes == [L.t("integrated_epics_repair_ci_hint")])
        #expect(card.confirmation == nil)
        #expect(card.steps[2].marker == .failure)
    }

    @Test func nothingToLandOpensTheEpicIssueAndRemovesInTheField() throws {
        let card = CompletedEpicCard(try F.epic(["landingState": "none"]), now: now)
        let issue = try #require(URL(string: "https://github.com/acme/widgets/issues/15"))
        #expect(card.buttons.map(\.action) == [.openURL(issue), .dismiss])
        #expect(card.notes == [L.t("integrated_epics_dismiss_hint")])
        #expect(!card.showsFooter)
        #expect(card.lockedReason == nil)
    }

    @Test func unacknowledgedMigrationsReplaceTheRemoveAction() throws {
        let card = CompletedEpicCard(try F.epic(["landingState": "merged", "migrationPaths": ["m/001.sql"]]), now: now)
        #expect(card.buttons.map(\.action) == [.ackMigrations])
        #expect(card.notes == [L.t("epic_migrations_pending", "1")])
        #expect(card.steps.map(\.marker) == [.done, .done, .done, .done])
    }

    @Test func childrenNameTheirPrOrTheirIssue() throws {
        let card = CompletedEpicCard(try F.epic(), now: now)
        #expect(card.childrenHeading == L.t("integrated_epics_children_heading", "1", "2"))
        #expect(card.children.map(\.ref) == [L.t("integrated_epics_pr_ref", "20"), "#4"])
        #expect(card.children.map(\.integrated) == [true, false])
        #expect(card.children[1].note == L.t("integrated_epics_child_closed"))
        // A child the forge never named carries no second line.
        #expect(card.children.map(\.title) == ["angebote: Datenmodell und Migrationen", nil])
    }

    @Test func strandedAndStaleConflictFlagsCarryTheirAge() throws {
        let stranded = CompletedEpicCard(try F.epic(["landingChecks": "success", "landingMergeable": true,
            "landingReady": true, "landingStranded": true]), now: 1_800_000_000_000 + 6 * 86_400_000)
        #expect(stranded.flags == [L.t("integrated_epics_land_stranded", "6d")])
        let conflict = CompletedEpicCard(try F.epic(["landingRebasePauseReason": "conflict",
            "landingConflictStranded": true, "landingConflictSince": 1_800_000_000_000]),
            now: 1_800_000_000_000 + 2 * 3_600_000)
        #expect(conflict.flags == [L.t("integrated_epics_land_conflict_stranded", "2h")])
    }

    @Test func everyCardStringResolves() throws {
        let situations: [[String: Any?]] = [
            ["landingState": "pending"], ["landingChecks": "pending"], ["landingRepairing": true],
            ["landingChecks": "failure", "landingCiAutomation": F.automation(reruns: "running", repair: "pending")],
            ["landingChecks": "failure", "landingCiAutomation": F.automation(reruns: "done", repair: "pending")],
            ["landingMergeable": false], ["landingRebasePauseReason": "driver"], ["landingState": "none"],
            ["landingReady": true], ["landingState": "merged"], ["landingState": "error"],
            ["landingChecks": "success", "landingMergeable": true],
        ]
        for fields in situations {
            let card = CompletedEpicCard(try F.epic(fields), now: now)
            let texts = [card.turnLabel, card.summary, card.heading, card.body, card.identity, card.finished]
                + card.steps.flatMap { [$0.label, $0.value] } + card.buttons.map(\.label) + card.notes
            for text in texts {
                #expect(!text.contains("integrated_epics_"), "\(fields): \(text)")
                #expect(!text.contains("[["), "\(fields): \(text)")
            }
        }
        #expect(CompletedEpicsBand.waitingLabel(1) == L.t("native_epics_waiting_on_you_one"))
        #expect(CompletedEpicsBand.waitingLabel(3) == L.t("integrated_epics_waiting_on_you", "3"))
        #expect(L.t("native_epics_load_failed") != "native_epics_load_failed")
    }
}

@MainActor
struct CompletedEpicsBandTests {
    private typealias F = CompletedEpicFixtures

    @Test func readyLeadsThenYourTurnThenQuietThenDone() throws {
        let landed = try F.epic(parent: 1, ["landingState": "merged"])
        let checking = try F.epic(parent: 2, ["landingChecks": "pending"])
        let conflict = try F.epic(parent: 3, ["landingMergeable": false])
        let ready = try F.epic(parent: 4, ["landingReady": true])
        let order = CompletedEpicsBand.sorted([landed, checking, conflict, ready]).map(\.parentIssueNumber)
        #expect(order == [4, 3, 2, 1])
        #expect(CompletedEpicsBand.waiting([landed, checking, conflict, ready]) == 2)
        // A land in flight is nobody's turn any more.
        let key = CompletedEpicsBand.key(ready)
        #expect(CompletedEpicsBand.waiting([ready], landing: [key]) == 0)
    }

    @Test func agoMatchesTheWebsFormat() {
        #expect(CompletedEpicsBand.ago(45_000) == "45s")
        #expect(CompletedEpicsBand.ago(12 * 60_000) == "12m")
        #expect(CompletedEpicsBand.ago(3 * 3_600_000) == "3h")
        #expect(CompletedEpicsBand.ago(6 * 86_400_000) == "6d")
        #expect(CompletedEpicsBand.ago(-5_000) == "0s")
    }
}

/// Counts and gates the model's calls; a gate holds a call until the test releases it.
actor CompletedEpicsProbe {
    private(set) var lists = 0
    private(set) var dismissed: [Int] = []
    private(set) var landed: [Int] = []
    var rows: [CompletedEpic] = []
    var failDismiss = false

    func list() -> [CompletedEpic] { lists += 1; return rows }
    func dismiss(_ parent: Int) throws {
        dismissed.append(parent)
        if failDismiss { throw ShepherdError.badRequest("refused") }
    }
    func land(_ parent: Int) { landed.append(parent) }
    func set(rows: [CompletedEpic]) { self.rows = rows }
    func set(failDismiss: Bool) { self.failDismiss = failDismiss }
}

@Suite(.serialized) @MainActor
struct CompletedEpicsModelTests {
    private typealias F = CompletedEpicFixtures

    private func eventually(_ condition: () async -> Bool) async -> Bool {
        let deadline = ContinuousClock.now + .seconds(10)
        while !(await condition()), ContinuousClock.now < deadline { await Task.yield() }
        return await condition()
    }

    private func model(_ probe: CompletedEpicsProbe) -> CompletedEpicsModel {
        CompletedEpicsModel(api: .init(
            list: { await probe.list() },
            land: { _, parent in await probe.land(parent) },
            dismiss: { _, parent in try await probe.dismiss(parent) }))
    }

    private func frame(_ object: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: object)
    }

    @Test func refreshLoadsAndFramesKeepTheBandLive() async throws {
        let probe = CompletedEpicsProbe()
        await probe.set(rows: [try F.epic(parent: 15)])
        let model = model(probe)
        defer { model.teardown() }
        await model.refresh()
        #expect(model.loaded)
        #expect(model.epics.map(\.parentIssueNumber) == [15])
        #expect(model.hasOpenLanding)

        let merged: [String: Any] = [
            "repoPath": "/repos/eemockup", "parentIssueNumber": 22, "parentTitle": "Epic #22",
            "completedAt": 1_800_000_000_000, "children": [[String: Any]](), "landingPrNumber": 30,
            "landingPrUrl": NSNull(), "landingState": "merged", "migrationPaths": [String](),
            "migrationsAckedAt": NSNull(), "landingRebasePauseReason": NSNull(), "landingConflictReworkCount": 0,
        ]
        model.receive(name: "epic:completed", payload: try frame(merged))
        #expect(model.epics.map(\.parentIssueNumber) == [22, 15])

        model.receive(name: "epic:completed-cleared",
            payload: try frame(["repoPath": "/repos/eemockup", "parentIssueNumber": 15]))
        #expect(model.epics.map(\.parentIssueNumber) == [22])
    }

    @Test func dismissIsOptimisticAndRestoresTheRowWhenTheServerRefuses() async throws {
        let probe = CompletedEpicsProbe()
        let epic = try F.epic(parent: 15)
        await probe.set(rows: [epic])
        await probe.set(failDismiss: true)
        let model = model(probe)
        defer { model.teardown() }
        await model.refresh()

        model.dismiss(epic)
        #expect(model.epics.isEmpty)
        #expect(await eventually { model.actionError != nil })
        #expect(model.epics.map(\.parentIssueNumber) == [15])
        #expect(model.actionError == L.t("integrated_epics_dismiss_failed"))
        #expect(await probe.dismissed == [15])
    }

    @Test func onlyAReadyRowIsSentToLand() async throws {
        let probe = CompletedEpicsProbe()
        let red = try F.epic(parent: 15, ["landingChecks": "failure"])
        let ready = try F.epic(parent: 16, ["landingReady": true])
        await probe.set(rows: [red, ready])
        let model = model(probe)
        defer { model.teardown() }
        await model.refresh()

        model.land(red)
        model.land(ready)
        #expect(model.landing == [CompletedEpicsBand.key(ready)])
        #expect(model.status(ready).situation == .landing)
        #expect(await eventually { model.landing.isEmpty })
        #expect(await probe.landed == [16])
    }
}
}
