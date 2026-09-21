import SwiftUI
import ShepherdKit

struct BackendRecoveryView: View {
    let failure: BackendFailure
    let isLocal: Bool
    var runnerMissing = false
    var startServer: () -> Void = {}
    var startRunner: () -> Void = {}
    var reopen: (() -> Void)?
    var diagnose: () -> Void
    var recheck: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(BackendRecovery.title(failure)).font(.headline)
                .accessibilityIdentifier("backend-recovery-title")
            Text(BackendRecovery.summary(failure)).foregroundStyle(.secondary)
                .accessibilityIdentifier("backend-recovery-summary")
            HStack {
                if isLocal && failure == .serverUnavailable {
                    Button(L.t("native_local_start"), action: startServer)
                        .accessibilityIdentifier("backend-recovery-action")
                } else if isLocal && failure == .runnerUnavailable && !runnerMissing {
                    Button(L.t("native_recovery_start_runner"), action: startRunner)
                        .accessibilityIdentifier("backend-recovery-action")
                } else if (failure == .sessionGone || failure == .sessionSuperseded), let reopen {
                    Button(L.t(failure == .sessionGone ? "cardmenu_resume" : "native_recovery_reopen"), action: reopen)
                        .accessibilityIdentifier(failure == .sessionGone ? "terminal-resume" : "backend-recovery-action")
                }
                if failure != .sessionGone && failure != .sessionSuperseded, let reopen {
                    Button(L.t("native_recovery_reopen"), action: reopen)
                        .accessibilityIdentifier("terminal-takeover")
                }
                Button(L.t("native_settings_diagnose"), action: diagnose)
                    .accessibilityIdentifier("backend-recovery-diagnose")
                Button(L.t("native_settings_refresh_diagnostics"), action: recheck)
            }
        }.padding().background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    }
}

/// All lifecycle actions recheck the selected profile at invocation, including its endpoint.
struct BackendRecoveryPanel: View {
    @Environment(AppModel.self) private var app
    let failure: BackendFailure
    var reopen: (() -> Void)?
    private var recovery: BackendRecoveryModel? { app.extension(BackendRecoveryModel.self) }
    private var local: LocalServerModel { LocalServerModel.shared }
    private var canStartLocal: Bool {
        BackendRecovery.canManageLocal(profile: app.activeProfile, endpoint: local.baseURL)
    }
    private var currentFailure: BackendFailure {
        if failure == .sessionGone || failure == .sessionSuperseded { return failure }
        return recovery?.diagnosis(for: nil) ?? failure
    }
    var body: some View {
        BackendRecoveryView(failure: currentFailure, isLocal: canStartLocal,
            runnerMissing: recovery?.diagnostics?.checks.contains(where: {
                $0.id == "herdr" && $0.hintKey == "diagnostics_hint_herdr_missing"
            }) == true,
            startServer: { runLocal(runner: false) }, startRunner: { runLocal(runner: true) },
            reopen: reopen,
            diagnose: { SettingsPresentation.shared.requestPane("diagnose") },
            recheck: { Task { await recovery?.refresh() } })
        if canStartLocal, case .failed(let failure) = local.state {
            Text(LocalServerCopy.message(for: failure)).foregroundStyle(.red)
        }
        if canStartLocal, let failure = local.runnerFailure {
            Text(LocalServerCopy.message(for: failure)).foregroundStyle(.red)
        }
    }
    private func runLocal(runner: Bool) {
        guard canStartLocal else { return }
        let activation = app.activationGeneration
        Task {
            guard canStartLocal, app.activationGeneration == activation else { return }
            if runner { await local.startRunner() } else { await local.start() }
            guard app.activationGeneration == activation else { return }
            await recovery?.refresh()
        }
    }
}
