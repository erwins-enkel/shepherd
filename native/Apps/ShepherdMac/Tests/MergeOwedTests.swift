import Foundation
import SwiftUI
import Testing
import ShepherdKit
@testable import Shepherd
@testable import ShepherdAppCore

private actor OwedSnapshots {
    var value: MergeSnapshot
    init(_ value: MergeSnapshot) { self.value = value }
    func read() -> MergeSnapshot { value }
    func replace(_ value: MergeSnapshot) { self.value = value }
}

extension MacSeamTests {
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

extension MacSeamTests.MergeOwedTests {
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
