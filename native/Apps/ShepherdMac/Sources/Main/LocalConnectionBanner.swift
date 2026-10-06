import ShepherdAppCore
import SwiftUI
import ShepherdKit

/// Mac-only refinement: the shared connection policy retains banner priority.
struct LocalConnectionBannerPolicy: Equatable {
    enum Action: Equatable {
        case start, settings
        var title: String {
            switch self {
            case .start: L.t("native_local_start")
            case .settings: L.t("native_local_banner_settings")
            }
        }
    }
    let message: String
    let action: Action?

    static func resolve(kind: BannerKind, profile: ServerProfile?, endpoint: URL,
                        state: LocalServerState) -> Self? {
        guard case .offline = kind,
              BackendRecovery.canManageLocal(profile: profile, endpoint: endpoint) else { return nil }
        switch state {
        case .stopped: return .init(message: L.t("native_local_banner_stopped"), action: .start)
        case .notInstalled: return .init(message: L.t("native_local_banner_not_installed"), action: .settings)
        case .starting: return .init(message: L.t("native_local_banner_starting"), action: nil)
        case .failed(let failure): return .init(message: LocalServerCopy.message(for: failure), action: .start)
        case .installing, .upgradingBun: return .init(message: LocalServerCopy.label(for: state), action: nil)
        case .running, .externallyManaged: return nil
        }
    }
}

struct LocalConnectionBanner: View {
    @Environment(AppModel.self) private var app
    let kind: BannerKind
    private var local: LocalServerModel { .shared }
    private var presentation: LocalConnectionBannerPolicy? {
        LocalConnectionBannerPolicy.resolve(kind: kind, profile: app.activeProfile,
            endpoint: local.baseURL, state: local.state)
    }
    private var canManageLocal: Bool {
        BackendRecovery.canManageLocal(profile: app.activeProfile, endpoint: local.baseURL)
    }
    private var isOffline: Bool {
        if case .offline = kind { return true }
        return false
    }
    // Refresh on appearance, activation, offline transition and explicit retry.
    // State changes do not trigger another probe, and no polling task is added.
    private var refreshID: String { "\(app.activationGeneration):\(isOffline):\(app.retrying)" }

    var body: some View {
        ConnectionBanner(kind: kind, isRetrying: app.retrying,
            localPresentation: presentation, localBusy: local.busy,
            onLocalAction: { action in
                guard canManageLocal, isOffline, presentation?.action == action else { return }
                switch action {
                case .start: BackendRecoveryLocalAction.run(app: app, local: local, runner: false)
                case .settings: SettingsPresentation.shared.requestPane("general")
                }
            }, onRetry: { app.retry() })
            .task(id: refreshID) {
                guard isOffline, canManageLocal, !Task.isCancelled else { return }
                await local.refresh()
            }
    }
}
