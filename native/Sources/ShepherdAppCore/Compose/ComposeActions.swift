import Foundation
import Observation
import ShepherdKit
import SwiftUI

/// State belongs to one sheet. Closing it fences even a cancellation-insensitive transport.
@Observable @MainActor
public final class ComposeActions {
    public enum Action: String, Identifiable {
        case variant, replace, recommend, close, steers
        public var id: String { rawValue }
        public var title: String {
            switch self {
            case .variant: L.t("experiment_variant_title")
            case .replace: L.t("experiment_replace_title")
            case .recommend: L.t("recommend_title")
            case .close: L.t("native_archive_confirm_title")
            case .steers: L.t("steerseditor_title")
            }
        }
    }

    public var provider: AgentProvider { didSet {
        if provider != oldValue { model = "default"; effort = "default" }
    } }
    public var model = "default" { didSet {
        if !efforts.contains(effort) { effort = "default" }
    } }
    public var effort = "default"
    public var handoff: ComposeReplaceRequest.HandoffModePayload = .resume
    public var steers: [ComposeSteer] = []
    public var leftovers: ComposeLeftovers?
    public var reap: Set<String> = []
    public var recommendation: String?
    public var loaded = false
    public private(set) var busy = false
    public private(set) var error: String?
    private var generation = 0
    private var active = true

    public init(provider: AgentProvider) { self.provider = provider }
    public var efforts: [String] { ["default"] + ComposeRunConfig.providerEfforts(provider, model: model) }
    public var variantRequest: ComposeVariantRequest {
        .init(agentProvider: provider, model: model == "default" ? nil : model,
              effort: effort == "default" ? nil : effort)
    }
    public var replaceRequest: ComposeReplaceRequest {
        .init(agentProvider: provider, model: model == "default" ? nil : model,
              effort: effort == "default" ? nil : effort, handoffMode: handoff)
    }
    public var canSaveSteers: Bool {
        steers.count <= 40 && steers.allSatisfy {
            let label = $0.label.trimmingCharacters(in: .whitespacesAndNewlines)
            let text = $0.text.trimmingCharacters(in: .whitespacesAndNewlines)
            return !label.isEmpty && label.utf16.count <= 60 && !text.isEmpty && text.utf16.count <= 4000
                && ($0.inSteerBar || $0.onIssues)
        }
    }

    @discardableResult
    public func run<Value: Sendable>(operation: () async throws -> Value, apply: (Value) -> Void,
                              isCurrent: () -> Bool) async -> Bool {
        guard active, !busy, isCurrent() else { return false }
        let stamp = generation
        busy = true; error = nil
        defer { if generation == stamp { busy = false } }
        do {
            let result = try await operation()
            guard active, generation == stamp, isCurrent(), !Task.isCancelled else { return false }
            apply(result)
            return true
        } catch {
            guard active, generation == stamp, isCurrent(), !Task.isCancelled else { return false }
            self.error = Self.message(error)
            return false
        }
    }

    /// Replace keeps the ID. A sessionNew event cannot update an already-populated store.
    /// Refresh through the store so buffered status/ready events retain their ordering.
    @discardableResult
    public func replace(id: String, choice: ComposeReplaceRequest, store: SessionStore,
                 select: (Session) -> Void, isCurrent: () -> Bool) async -> Bool {
        let stamp = generation
        return await run(operation: {
            let session = try await store.client.replaceSessionAgent(id: id, choice: choice)
            guard active, generation == stamp, isCurrent(), !Task.isCancelled else {
                throw ShepherdError.cancelled
            }
            try await store.refresh()
            return session
        }, apply: select, isCurrent: isCurrent)
    }

    public static func matchesSelection(sessionID: String?, selectedID: String?) -> Bool {
        sessionID == nil || sessionID == selectedID
    }

    public func teardown() { active = false; generation += 1; busy = false }

    private static func message(_ error: any Error) -> String {
        if case ComposeRecommendationError.failed(let slug) = error {
            switch slug {
            case "no-history": return L.t("recommend_err_no_history")
            case "spawn-failed": return L.t("recommend_err_spawn_failed")
            case "timeout": return L.t("recommend_err_timeout")
            case "unavailable": return L.t("recommend_err_unavailable")
            default: return L.t("native_actions_failed", slug)
            }
        }
        return L.t("native_actions_failed", String(describing: error))
    }
}
