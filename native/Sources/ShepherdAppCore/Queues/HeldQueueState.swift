import Foundation
import ShepherdKit
import SwiftUI

/// Presentation and the explicit stored-input -> writable-request boundary. Server-owned
/// fields such as `auto` are not part of CreateSessionRequest and never go into PATCH.
public enum HeldQueuePresentation {
    static func reasonKey(_ reason: HeldReason?) -> StaticString {
        switch reason?.known {
        case .usage: "native_held_reason_usage"
        case .capacity: "native_held_reason_capacity"
        case nil: "native_held_reason_unknown"
        }
    }

    public static func reasonLabel(_ reason: HeldReason?) -> String { L.t(reasonKey(reason)) }

    public static func badgeLabel(_ count: Int) -> String { L.t("topbar_held_badge", String(count)) }

    public static func showsBadge(_ count: Int) -> Bool { count > 0 }

    public static func originalProvider(_ entry: HeldQueueEntry) -> AgentProvider {
        entry.input.agentProvider ?? .claude
    }

    public static func providerLabel(_ provider: AgentProvider) -> String {
        provider == .claude ? L.t("agent_provider_claude") : L.t("agent_provider_codex")
    }

    public static func spawnOverride(_ entry: HeldQueueEntry, selected: AgentProvider?) -> AgentProvider? {
        guard let selected, selected != originalProvider(entry) else { return nil }
        return selected
    }

    public static func editRequest(_ input: Components.Schemas.HeldQueueInput) -> CreateSessionRequest {
        .init(repoPath: input.repoPath, baseBranch: input.baseBranch, prompt: input.prompt,
              agentProvider: input.agentProvider, model: input.model, effort: input.effort,
              images: input.images, planGateEnabled: input.planGateEnabled,
              autopilotEnabled: input.autopilotEnabled, sandboxProfile: input.sandboxProfile,
              plain: input.plain, force: input.force, mergeTrainPrs: input.mergeTrainPrs,
              issueRef: input.issueRef, research: input.research, epicAuthoring: input.epicAuthoring,
              attachmentNames: input.attachmentNames, launchUiState: input.launchUiState)
    }

    public static func canSave(_ request: CreateSessionRequest) -> Bool {
        !request.repoPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !request.baseBranch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !request.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && request.prompt.count <= 8_000
    }
}

/// The row's dialog routes cancellation and dismissal through the same no-command path.
public struct HeldDiscardConfirmation {
    public init() {}

    public private(set) var isPresented = false
    public mutating func request() { isPresented = true }
    public mutating func cancel() { isPresented = false }
    public mutating func confirm(perform: () -> Void) {
        guard isPresented else { return }
        isPresented = false
        perform()
    }
}

public enum HeldQueueAction {
    case spawn(AgentProvider?)
    case edit(CreateSessionRequest)
    case discard

    var failureKey: StaticString {
        switch self {
        case .spawn: "topbar_held_spawn_failed"
        case .edit: "newtask_edit_held_failed"
        case .discard: "topbar_held_discard_failed"
        }
    }
}

/// Only command dependencies: busy/error state belongs to SessionCommandState.
@MainActor
public struct HeldQueueCommands {
    var spawn: (String, AgentProvider?) async throws -> Void
    var update: (String, CreateSessionRequest) async throws -> Void
    var discard: (String) async throws -> Void
    var reload: () async throws -> Void

    public static func live(_ client: ShepherdClient, model: QueuesModel) -> Self {
        Self(spawn: { _ = try await client.spawnHeld(id: $0, agentProvider: $1) },
             update: { _ = try await client.updateHeld(id: $0, input: $1) },
             discard: { try await client.discardHeld(id: $0) },
             reload: { try await model.reloadHeld() })
    }

    public func run(_ action: HeldQueueAction, id: String, gate: SessionCommandState,
             isCurrent: () -> Bool) async -> Bool {
        guard isCurrent() else { return false }
        return await gate.run({
            switch action {
            case .spawn(let provider): try await spawn(id, provider)
            case .edit(let input): try await update(id, input)
            case .discard: try await discard(id)
            }
            guard isCurrent() else { return }
            // The response is not a local list mutation. In particular, DELETE also succeeds
            // for missing ids, and the spawned Session is installed only by session:new.
            try await reload()
        }, failureCopy: { L.t(action.failureKey) + "\n" + $0 }, isCurrent: isCurrent)
    }
}
