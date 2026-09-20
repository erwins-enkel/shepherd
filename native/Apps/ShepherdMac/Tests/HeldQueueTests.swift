import Foundation
import ShepherdKit
import Testing
@testable import Shepherd

@MainActor
struct HeldQueueTests {
    private func entry() throws -> HeldQueueEntry {
        try JSONDecoder().decode(HeldQueueEntry.self, from: Data(#"""
        {"id":"held-a","repoPath":"/repos/shepherd","createdAt":1,"reason":"usage",
         "input":{"repoPath":"/repos/shepherd","baseBranch":"feature/base","prompt":"Fix the queue",
                  "agentProvider":"codex","model":"gpt-test","effort":"high",
                  "images":["/staged/image.png"],"attachmentNames":["reference.png"],
                  "planGateEnabled":true,"autopilotEnabled":false,"plain":false,"force":true,
                  "sandboxProfile":"standard",
                  "launchUiState":{"researchChecked":true,"planGateChecked":true,"autopilotChecked":false},
                  "mergeTrainPrs":[12,34],"research":true,"epicAuthoring":false,"auto":true,
                  "issueRef":{"number":42,"url":"https://example.test/42","title":"Queue","body":"Fix"}}}
        """#.utf8))
    }

    @Test func discardCancelSendsNoRequestAndConfirmationSendsExactlyOne() async {
        var calls: [String] = []
        var pending: Task<Bool, Never>?
        let commands = HeldQueueCommands(spawn: { _, _ in }, update: { _, _ in },
            discard: { calls.append($0) }, reload: { calls.append("read") })
        let perform = {
            pending = Task { await commands.run(.discard, id: "a", gate: SessionCommandState(),
                                                isCurrent: { true }) }
        }
        var confirmation = HeldDiscardConfirmation()
        confirmation.request()
        #expect(confirmation.isPresented && calls.isEmpty)
        confirmation.cancel()
        confirmation.confirm(perform: perform)
        #expect(pending == nil && calls.isEmpty && !confirmation.isPresented)
        confirmation.request()
        confirmation.confirm(perform: perform)
        confirmation.confirm(perform: perform)
        #expect(await pending?.value == true)
        #expect(calls == ["a", "read"] && !confirmation.isPresented)
    }

    @Test(arguments: ["en", "de"])
    func heldReasonLabelsCoverKnownUnknownAndMissingValues(language: String) throws {
        let path = try #require(Bundle.main.path(forResource: language, ofType: "lproj"))
        let bundle = try #require(Bundle(path: path))
        let expected = language == "en"
            ? ["Held because usage is high.", "Held because no account has capacity.", "Held — reason unavailable."]
            : ["Zurückgehalten, weil die Nutzung hoch ist.", "Zurückgehalten, weil kein Konto Kapazität hat.",
               "Zurückgehalten — Grund nicht verfügbar."]
        for (index, reason) in ["usage", "capacity", "future-reason"].enumerated() {
            var row = try entry()
            row.reason = try JSONDecoder().decode(HeldReason.self, from: JSONEncoder().encode(reason))
            let key = HeldQueuePresentation.reasonKey(row.reason)
            #expect(bundle.localizedString(forKey: "\(key)", value: nil, table: nil) == expected[index])
            #expect(HeldQueuePresentation.reasonLabel(row.reason) == L.t(key))
        }
        #expect(HeldQueuePresentation.reasonLabel(nil) == L.t("native_held_reason_unknown"))
    }

    @Test func badgeOnlyRendersForAPositiveHeldCount() {
        #expect(!HeldQueuePresentation.showsBadge(0))
        #expect(!HeldQueuePresentation.showsBadge(-1))
        #expect(HeldQueuePresentation.showsBadge(1))
        #expect(HeldQueuePresentation.badgeLabel(2) == L.t("topbar_held_badge", "2"))
    }

    @Test func providerOverrideOnlyFollowsTheChangedRowSelection() throws {
        var a = try entry()
        #expect(HeldQueuePresentation.originalProvider(a) == .codex)
        #expect(HeldQueuePresentation.spawnOverride(a, selected: nil) == nil)
        #expect(HeldQueuePresentation.spawnOverride(a, selected: .codex) == nil)
        #expect(HeldQueuePresentation.spawnOverride(a, selected: .claude) == .claude)
        a.input.agentProvider = nil
        #expect(HeldQueuePresentation.originalProvider(a) == .claude)
        #expect(HeldQueuePresentation.spawnOverride(a, selected: .claude) == nil)
        #expect(HeldQueuePresentation.spawnOverride(a, selected: .codex) == .codex)
        #expect(DonePresentation.repoBasename(a.repoPath) == "shepherd")
    }

    @Test func editStartsWithTheFullWritableInputAndPreservesUnshownFields() throws {
        let row = try entry()
        var request = HeldQueuePresentation.editRequest(row.input)
        #expect(request.repoPath == row.input.repoPath && request.baseBranch == "feature/base")
        #expect(request.prompt == "Fix the queue" && request.agentProvider == .codex)
        #expect(request.model == "gpt-test" && request.effort == .high)
        request.prompt = "Edited prompt"
        let json = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(request))
            as? [String: Any])
        var expected = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(row.input))
            as? [String: Any])
        expected.removeValue(forKey: "auto") // Server-owned; not a writable create field.
        expected["prompt"] = "Edited prompt"
        #expect(json as NSDictionary == expected as NSDictionary)
        #expect(request.mergeTrainPrs == [12, 34])
    }

    @Test func editValidationRejectsMissingFieldsAndOversizedPrompts() throws {
        var request = HeldQueuePresentation.editRequest(try entry().input)
        #expect(HeldQueuePresentation.canSave(request))
        request.prompt = " \n "
        #expect(!HeldQueuePresentation.canSave(request))
        request.prompt = String(repeating: "a", count: 8_001)
        #expect(!HeldQueuePresentation.canSave(request))
        request.prompt = "valid"
        request.repoPath = " "
        #expect(!HeldQueuePresentation.canSave(request))
        request.repoPath = "/repo"
        request.baseBranch = " "
        #expect(!HeldQueuePresentation.canSave(request))
    }

    @Test func spawnAndDiscardRereadInsteadOfRemovingRowsLocally() async {
        var calls: [String] = []
        let gate = SessionCommandState()
        let commands = HeldQueueCommands(
            spawn: { id, provider in calls.append("spawn:\(id):\(provider?.rawValue ?? "unchanged")") },
            update: { _, _ in Issue.record("unexpected edit") },
            discard: { id in calls.append("discard:\(id)") },
            reload: { calls.append("read") })
        #expect(await commands.run(.spawn(nil), id: "a", gate: gate, isCurrent: { true }))
        #expect(await commands.run(.spawn(.codex), id: "b", gate: gate, isCurrent: { true }))
        #expect(await commands.run(.discard, id: "missing-id", gate: gate, isCurrent: { true }))
        #expect(calls == ["spawn:a:unchanged", "read", "spawn:b:codex", "read", "discard:missing-id", "read"])
        #expect(!gate.busy && gate.message == nil)
    }

    @Test func saveSendsTheFullRequestAndThenRereads() async throws {
        let input = HeldQueuePresentation.editRequest(try entry().input)
        var saved: CreateSessionRequest?
        var calls: [String] = []
        let commands = HeldQueueCommands(spawn: { _, _ in }, update: { id, request in
            calls.append("edit:\(id)"); saved = request
        }, discard: { _ in }, reload: { calls.append("read") })
        #expect(await commands.run(.edit(input), id: "a", gate: SessionCommandState(), isCurrent: { true }))
        #expect(saved == input && calls == ["edit:a", "read"])
    }

    @Test func everyMutationUsesTheExistingGateAndShowsItsFailure() async throws {
        let input = HeldQueuePresentation.editRequest(try entry().input)
        let commands = HeldQueueCommands(
            spawn: { _, _ in throw ShepherdError.notFound },
            update: { _, _ in throw ShepherdError.notFound },
            discard: { _ in throw ShepherdError.notFound },
            reload: { Issue.record("failed mutations must not reread") })
        for action in [HeldQueueAction.spawn(nil), .edit(input), .discard] {
            let gate = SessionCommandState()
            #expect(await commands.run(action, id: "a", gate: gate, isCurrent: { true }) == false)
            #expect(gate.message?.contains(L.t(action.failureKey)) == true)
            #expect(!gate.busy)
        }
    }

    @Test func busyGateRejectsAnotherRowsActionUntilRefreshFinishes() async {
        let pause = LoadGate()
        let gate = SessionCommandState()
        var mutations = 0
        let commands = HeldQueueCommands(spawn: { _, _ in mutations += 1 }, update: { _, _ in },
            discard: { _ in mutations += 1 }, reload: { await pause.wait() })
        let first = Task { await commands.run(.spawn(nil), id: "a", gate: gate, isCurrent: { true }) }
        #expect(await settleDetail(until: { pause.isWaiting }))
        #expect(gate.busy)
        #expect(await commands.run(.discard, id: "b", gate: gate, isCurrent: { true }) == false)
        pause.open()
        #expect(await first.value)
        #expect(mutations == 1 && !gate.busy)
    }

    @Test func activationChangeDropsMutationCompletionAndLateErrors() async {
        let pause = LoadGate()
        var current = true
        var reads = 0
        let gate = SessionCommandState()
        let commands = HeldQueueCommands(spawn: { _, _ in await pause.wait() },
            update: { _, _ in }, discard: { _ in throw ShepherdError.notFound },
            reload: { reads += 1 })
        let first = Task { await commands.run(.spawn(nil), id: "a", gate: gate, isCurrent: { current }) }
        #expect(await settleDetail(until: { pause.isWaiting }))
        current = false
        pause.open()
        #expect(await first.value == false)
        #expect(reads == 0 && gate.message == nil)
        #expect(await commands.run(.discard, id: "a", gate: gate, isCurrent: { false }) == false)
        #expect(gate.message == nil)
    }

    @Test func lateCommandFailureCannotLeakIntoTheNextPresentation() async {
        let pause = LoadGate()
        var current = true
        let gate = SessionCommandState()
        let commands = HeldQueueCommands(spawn: { _, _ in }, update: { _, _ in },
            discard: { _ in await pause.wait(); throw ShepherdError.notFound }, reload: {})
        let pending = Task { await commands.run(.discard, id: "a", gate: gate, isCurrent: { current }) }
        #expect(await settleDetail(until: { pause.isWaiting }))
        current = false
        pause.open()
        #expect(await pending.value == false)
        #expect(gate.message == nil && !gate.busy)
    }

    @Test func failedRereadStaysVisibleInTheSameCommandGate() async {
        let gate = SessionCommandState()
        let commands = HeldQueueCommands(spawn: { _, _ in }, update: { _, _ in }, discard: { _ in },
            reload: { throw ShepherdError.notFound })
        #expect(await commands.run(.discard, id: "a", gate: gate, isCurrent: { true }) == false)
        #expect(gate.message != nil && !gate.busy)
    }
    private var emptyReads: QueuesReads {
        .init(held: { [] }, done: { [] }, recaps: { [:] }, stranded: { [] }, refreshUpNext: {})
    }

    @Test func heldOnlyRereadUpdatesTheListAndCountAndPropagatesErrors() async throws {
        let model = QueuesModel(reads: emptyReads)
        defer { model.teardown() }
        let row = try entry()
        model.reads.held = { [row] }
        try await model.reloadHeld()
        #expect(model.held == [row] && model.heldCount == 1)
        model.reads.held = { throw ShepherdError.notFound }
        await #expect(throws: ShepherdError.notFound) { try await model.reloadHeld() }
        #expect(model.held == [row] && model.heldCount == 1)
        model.reads.held = { [] }
        try await model.reloadHeld()
        #expect(model.held.isEmpty && model.heldCount == 0)
    }

    @Test func olderBackgroundReadCannotUndoCommandReread() async throws {
        let pause = LoadGate()
        let model = QueuesModel(reads: emptyReads)
        defer { model.teardown() }
        model.reads.held = { await pause.wait(); return [] }
        let background = Task { await model.refresh(recomputeUpNext: false) }
        #expect(await settleDetail(until: { pause.isWaiting }))
        let row = try entry()
        model.reads.held = { [row] }
        try await model.reloadHeld()
        pause.open()
        await background.value
        #expect(model.held == [row] && model.heldCount == 1)
    }

    @Test func teardownDropsLateCommandReread() async throws {
        let pause = LoadGate()
        let model = QueuesModel(reads: emptyReads)
        let row = try entry()
        model.reads.held = { await pause.wait(); return [row] }
        let pending = Task { try await model.reloadHeld() }
        #expect(await settleDetail(until: { pause.isWaiting }))
        model.teardown()
        pause.open()
        try await pending.value
        #expect(model.held.isEmpty && model.heldCount == 0)
    }

}
