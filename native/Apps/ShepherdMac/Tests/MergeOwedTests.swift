import Foundation
import SwiftUI
import Testing
import ShepherdKit
@testable import Shepherd

private actor OwedSnapshots {
    var value: MergeSnapshot
    init(_ value: MergeSnapshot) { self.value = value }
    func read() -> MergeSnapshot { value }
    func replace(_ value: MergeSnapshot) { self.value = value }
}

@MainActor struct MergeOwedTests {
    private func record() throws -> PostMergeSteps {
        try JSONDecoder().decode(PostMergeSteps.self, from: Data(
            #"{"sessionId":"pruned","desig":"TASK-1","repoPath":"/a","prNumber":7,"prTitle":"Ship","steps":[{"id":"one","text":"Rotate fixture key","postMerge":true,"doneAt":null}],"trackingIssueUrl":"https://example.test/issues/8","trackingIssueNumber":8,"createdAt":1,"updatedAt":1,"clearedAt":null}"#.utf8))
    }
    private func eventually(_ condition: () -> Bool) async -> Bool {
        let deadline = ContinuousClock.now + .seconds(2)
        while !condition(), ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(1))
        }
        return condition()
    }
    private var noWrites: MergeOwedActions {
        .init(toggle: { _, _, _ in Issue.record("unexpected toggle") },
              dismiss: { _ in Issue.record("unexpected dismissal") })
    }
    @Test func prunedRecordSuppliesTheRenderedCardAndRepoFilter() async throws {
        let record = try record()
        let model = MergeModel(reads: .init(snapshot: { .init(owed: [record]) }))
        defer { model.teardown() }
        let state = MergeOwedState(model: model, actions: noWrites)
        await model.refresh()
        model.prune(liveIDs: [])
        let card = try #require(state.records(repos: []).first)
        #expect(card.sessionId == "pruned")
        #expect(card.desig == "TASK-1")
        #expect(card.prTitle == "Ship")
        #expect(card.steps.first?.text == "Rotate fixture key")
        #expect(card.steps.first?.postMerge == true)
        #expect(card.trackingIssueUrl == "https://example.test/issues/8")
        #expect(state.records(repos: ["/a"]).count == 1)
        #expect(state.records(repos: ["/b"]).isEmpty)
    }
    @Test func tickAndUntickSendTheDisplayedRecordAndStep() async throws {
        let record = try record()
        let model = MergeModel(reads: .init(snapshot: { .init() }))
        defer { model.teardown() }
        var ids: [String] = []
        var steps: [String] = []
        var values: [Bool] = []
        let state = MergeOwedState(model: model, actions: .init(toggle: { id, step, body in
            ids.append(id); steps.append(step); values.append(body.done)
        }, dismiss: { _ in Issue.record("toggle must not dismiss") }))
        for done in [true, false] {
            state.toggle(recordID: record.sessionId, stepID: record.steps[0].id, done: done)
            #expect(await eventually { !model.busy })
        }
        #expect(ids == ["pruned", "pruned"])
        #expect(steps == ["one", "one"])
        #expect(values == [true, false])
    }
    @Test func dismissRequiresConfirmationAndTargetsTheDurableRecord() async {
        let model = MergeModel(reads: .init(snapshot: { .init() }))
        defer { model.teardown() }
        var dismissed: [String] = []
        let state = MergeOwedState(model: model, actions: .init(toggle: { _, _, _ in
            Issue.record("dismiss must not toggle")
        }, dismiss: { dismissed.append($0) }))
        state.requestDismiss("pruned")
        #expect(state.dismissID == "pruned")
        #expect(dismissed.isEmpty)
        state.cancelDismiss()
        state.confirmDismiss()
        #expect(dismissed.isEmpty)
        state.requestDismiss("pruned")
        state.confirmDismiss()
        #expect(await eventually { !model.busy })
        #expect(dismissed == ["pruned"])
        #expect(state.dismissID == nil)
    }
    @Test(arguments: ["post-merge-steps:changed", "session:manual-steps"])
    func eachEventChangesTheOwedSnapshot(_ event: String) async throws {
        let record = try record()
        let source = OwedSnapshots(.init(owed: [record]))
        let model = MergeModel(reads: .init(snapshot: { await source.read() }))
        defer { model.teardown() }
        let state = MergeOwedState(model: model, actions: noWrites)
        await model.refresh()
        #expect(state.records(repos: []).first?.steps[0].doneAt == nil)
        var changed = record
        changed.steps[0].doneAt = 42
        await source.replace(.init(owed: [changed]))
        model.receive(name: event)
        #expect(await eventually { state.records(repos: []).first?.steps.first?.doneAt == 42 })
        await source.replace(.init())
        model.receive(name: event)
        #expect(await eventually { state.records(repos: []).isEmpty })
    }
    @Test func confirmedDismissalWaitsForASlowToggleAndIsSentOnce() async {
        let model = MergeModel(reads: .init(snapshot: { .init() }))
        defer { model.teardown() }
        let (stream, release) = AsyncStream<Void>.makeStream()
        defer { release.finish() }
        var calls: [String] = []
        let state = MergeOwedState(model: model, actions: .init(toggle: { _, _, _ in
            calls.append("toggle-start")
            for await _ in stream { break }
            calls.append("toggle-end")
        }, dismiss: { calls.append("dismiss:" + $0) }))
        state.toggle(recordID: "pruned", stepID: "one", done: true)
        #expect(await eventually { calls == ["toggle-start"] })
        state.requestDismiss("pruned")
        state.confirmDismiss()
        #expect(state.dismissID == nil)
        #expect(model.busy)
        #expect(calls == ["toggle-start"])
        release.yield(())
        #expect(await eventually { !model.busy })
        #expect(calls == ["toggle-start", "toggle-end", "dismiss:pruned"])
    }
    @Test func queuedDismissalCannotStartAfterTeardown() async {
        let model = MergeModel(reads: .init(snapshot: { .init() }))
        let (stream, release) = AsyncStream<Void>.makeStream()
        defer { release.finish() }
        var started = false
        var dismissed = false
        let state = MergeOwedState(model: model, actions: .init(toggle: { _, _, _ in
            started = true
            for await _ in stream { break }
        }, dismiss: { _ in dismissed = true }))
        state.toggle(recordID: "pruned", stepID: "one", done: true)
        #expect(await eventually { started })
        state.requestDismiss("pruned")
        state.confirmDismiss()
        model.teardown()
        release.yield(())
        for _ in 0..<20 { await Task.yield() }
        #expect(!dismissed)
        #expect(!model.busy)
    }
}

// Inspect the actual SwiftUI value tree, expanding lazy ForEach content. Stop at
// reference storage so observation/model fields cannot masquerade as rendered text.
@MainActor private protocol MergeInspectableChildren {
    var mergeChildren: [Any] { get }
}
extension ForEach: MergeInspectableChildren where Content: View {
    fileprivate var mergeChildren: [Any] { data.map { content($0) } }
}
// Recent SwiftUI stores Toggle's binding as an internal three-state enum.
// Copy its typed value from a fixture Toggle through Binding's public interface;
// this invokes the rendered control's setter without naming a private SDK type.
@MainActor private protocol MergeInspectableBinding {
    var inspectedValue: Any { get }
    func setInspectedValue(_ value: Any) throws
}
extension Binding: MergeInspectableBinding {
    fileprivate var inspectedValue: Any { wrappedValue }
    fileprivate func setInspectedValue(_ value: Any) throws {
        wrappedValue = try #require(value as? Value)
    }
}
@MainActor private func elements<T>(_ value: Any, of type: T.Type, depth: Int = 0) -> [T] {
    guard depth < 35 else { return [] }
    if let result = value as? T { return [result] }
    if let repeated = value as? any MergeInspectableChildren {
        return repeated.mergeChildren.flatMap { elements($0, of: type, depth: depth + 1) }
    }
    let mirror = Mirror(reflecting: value)
    guard mirror.displayStyle != .class else { return [] }
    return mirror.children.flatMap { elements($0.value, of: type, depth: depth + 1) }
}

@MainActor private func invokeButton(_ button: Button<Text>) throws {
    let action = try #require(Mirror(reflecting: button).children.first { $0.label == "action" }?.value)
    let closure = try #require(Mirror(reflecting: action).children.first { $0.label == "closure" }?.value)
    // This SDK reflects the closure as @MainActor () -> (), but Swift's dynamic
    // function cast rejects it. Open its actual type and verify both signature and
    // layout before the test-only ABI cast; never inspect arbitrary model storage.
    try #require(String(reflecting: type(of: closure)) == "@Swift.MainActor () -> ()")
    func invoke<Value>(_ value: Value) throws {
        try #require(MemoryLayout<Value>.size == MemoryLayout<@MainActor () -> Void>.size)
        let call = unsafeBitCast(value, to: (@MainActor () -> Void).self)
        call()
    }
    try _openExistential(closure, do: invoke)
}

extension MergeOwedTests {
    @Test func actualOwedBodyRendersFrozenCardAndFiltersRepos() async throws {
        let record = try record()
        let model = MergeModel(reads: .init(snapshot: { .init(owed: [record]) }))
        defer { model.teardown() }
        await model.refresh(); model.prune(liveIDs: [])
        let state = MergeOwedState(model: model, actions: noWrites)
        let view = MergeOwedView(state: state)
        let renderedText = elements(view.body, of: Text.self)
        #expect(renderedText.contains(Text(verbatim: "TASK-1 · /a · Ship")))
        #expect(renderedText.contains(Text(verbatim: "Rotate fixture key").strikethrough(false)))
        #expect(renderedText.contains(Text(L.t("owed_post_merge_badge"))))
        #expect(elements(view.body, of: Link<Text>.self).count == 1)
        let filtered = MergeOwedView(state: state, repos: ["/b"])
        #expect(!elements(filtered.body, of: Text.self).contains(Text(verbatim: "TASK-1 · /a · Ship")))
        #expect(elements(filtered.body, of: Text.self).contains(Text(L.t("owed_empty"))))
    }
    @Test func actualOwedToggleInvokesModel() async throws {
        let record = try record()
        let model = MergeModel(reads: .init(snapshot: { .init(owed: [record]) }))
        defer { model.teardown() }
        await model.refresh()
        var calls: [String] = []
        let state = MergeOwedState(model: model, actions: .init(toggle: { id, step, body in
            calls.append("toggle:\(id):\(step):\(body.done)")
        }, dismiss: { calls.append("dismiss:" + $0) }))
        let view = MergeOwedView(state: state)
        // Select the Toggle's binding specifically, excluding dialog presentation.
        let toggles = elements(view.body, of: Toggle<HStack<TupleView<(Text?, Text)>>>.self)
        let toggle = try #require(toggles.first)
        let binding = try #require(elements(toggle, of: (any MergeInspectableBinding).self).first)
        for done in [true, false] {
            let fixture = Toggle("fixture", isOn: .constant(done))
            let value = try #require(elements(fixture, of: (any MergeInspectableBinding).self).first)
            try binding.setInspectedValue(value.inspectedValue)
            #expect(model.busy)
            #expect(await eventually { !model.busy })
        }
        #expect(calls == ["toggle:pruned:one:true", "toggle:pruned:one:false"])
    }
    @Test func actualOwedDismissControlsInvokeModel() async throws {
        let record = try record()
        let model = MergeModel(reads: .init(snapshot: { .init(owed: [record]) }))
        defer { model.teardown() }
        await model.refresh()
        var calls: [String] = []
        let state = MergeOwedState(model: model, actions: .init(toggle: { _, _, _ in
            Issue.record("dismiss must not toggle")
        }, dismiss: { calls.append($0) }))
        let view = MergeOwedView(state: state)
        let buttons = elements(view.body, of: Button<Text>.self)
        let request = try #require(buttons.first {
            elements($0, of: ButtonRole.self).isEmpty
        })
        try invokeButton(request)
        #expect(state.dismissID == "pruned")
        #expect(calls.isEmpty)
        // The destructive confirmation is in the dialog modifier, not a state-only call.
        let confirmation = try #require(buttons.first {
            !elements($0, of: ButtonRole.self).isEmpty
        })
        try invokeButton(confirmation)
        #expect(model.busy)
        #expect(await eventually { !model.busy })
        #expect(calls == ["pruned"])
        #expect(state.dismissID == nil)
    }
}
