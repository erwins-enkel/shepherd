import Foundation
import Observation
import ShepherdKit
import SwiftUI

/// State belongs to one sheet. Closing it fences even a cancellation-insensitive transport.
@Observable @MainActor
final class ComposeActions {
    enum Action: String, Identifiable {
        case variant, replace, recommend, close, steers
        var id: String { rawValue }
        var title: String {
            switch self {
            case .variant: L.t("experiment_variant_title")
            case .replace: L.t("experiment_replace_title")
            case .recommend: L.t("recommend_title")
            case .close: L.t("native_archive_confirm_title")
            case .steers: L.t("steerseditor_title")
            }
        }
    }

    var provider: AgentProvider { didSet {
        if provider != oldValue { model = "default"; effort = "default" }
    } }
    var model = "default" { didSet {
        if !efforts.contains(effort) { effort = "default" }
    } }
    var effort = "default"
    var handoff: ComposeReplaceRequest.HandoffModePayload = .resume
    var steers: [ComposeSteer] = []
    var leftovers: ComposeLeftovers?
    var recommendation: String?
    var loaded = false
    private(set) var busy = false
    private(set) var error: String?
    private var generation = 0
    private var active = true

    init(provider: AgentProvider) { self.provider = provider }
    var efforts: [String] { ["default"] + ComposeRunConfig.providerEfforts(provider, model: model) }
    var variantRequest: ComposeVariantRequest {
        .init(agentProvider: provider, model: model == "default" ? nil : model,
              effort: effort == "default" ? nil : effort)
    }
    var replaceRequest: ComposeReplaceRequest {
        .init(agentProvider: provider, model: model == "default" ? nil : model,
              effort: effort == "default" ? nil : effort, handoffMode: handoff)
    }
    var canSaveSteers: Bool {
        steers.count <= 40 && steers.allSatisfy {
            let label = $0.label.trimmingCharacters(in: .whitespacesAndNewlines)
            let text = $0.text.trimmingCharacters(in: .whitespacesAndNewlines)
            return !label.isEmpty && label.utf16.count <= 60 && !text.isEmpty && text.utf16.count <= 4000
                && ($0.inSteerBar || $0.onIssues)
        }
    }

    @discardableResult
    func run<Value: Sendable>(operation: () async throws -> Value, apply: (Value) -> Void,
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

    func teardown() { active = false; generation += 1; busy = false }

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

/// The composition seam preserves the existing action bar. Install after S4, once per scene.
/// The integration lane already owns the call to ComposeStream.install; no shared view changes.
struct ComposeSessionActions: View {
    let session: Session
    let store: SessionStore
    let app: AppModel
    @State private var action: ComposeActions.Action?

    var body: some View {
        HStack {
            Menu(L.t("native_actions_bar_label")) {
                Button(L.t("cardmenu_start_variant")) { action = .variant }
                Button(L.t("cardmenu_replace_with")) { action = .replace }
                Button(L.t("recommend_title")) { action = .recommend }
                Divider()
                Button(L.t("cardmenu_decommission")) { action = .close }
                Divider()
                Button(L.t("steerbar_edit")) { action = .steers }
            }
            .disabled(session.status.known == .archived)
            .accessibilityIdentifier("compose.session-actions")
            Spacer()
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .sheet(item: $action) { mode in
            ComposeActionSheet(mode: mode, session: session, store: store, app: app,
                               activation: app.activationGeneration)
        }
    }
}
