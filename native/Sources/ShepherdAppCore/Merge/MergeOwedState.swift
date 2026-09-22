import SwiftUI
import Observation
import ShepherdKit

@MainActor public struct MergeOwedActions {
    var toggle: @MainActor (String, String, ManualStepToggle) async throws -> Void
    var dismiss: @MainActor (String) async throws -> Void

    public static func live(_ client: ShepherdClient) -> Self {
        .init(toggle: { id, stepID, body in
            _ = try await client.setManualStepDone(id: id, stepId: stepID, body: body)
        }, dismiss: { id in
            _ = try await client.dismissManualSteps(id: id)
        })
    }
}

@Observable @MainActor public final class MergeOwedState {
    public let model: MergeModel
    private let actions: MergeOwedActions
    public private(set) var dismissID: String?

    public init(model: MergeModel, actions: MergeOwedActions) {
        self.model = model
        self.actions = actions
    }
    public func records(repos: Set<String>) -> [PostMergeSteps] {
        MergeRules.owed(model.snapshot.owed, repos: repos)
    }
    public func toggle(recordID: String, stepID: String, done: Bool) {
        model.perform { [actions] in
            try await actions.toggle(recordID, stepID, .init(done: done))
        }
    }
    public func requestDismiss(_ id: String) { dismissID = id }
    public func cancelDismiss() { dismissID = nil }
    public func confirmDismiss() {
        guard let id = dismissID else { return }
        // Like the web panel, accept dismissal while a toggle is in flight. Preserve it
        // behind that write so the serial model cannot silently drop the confirmation.
        model.perform(queueIfBusy: true) { [actions] in try await actions.dismiss(id) }
        dismissID = nil
    }
}
