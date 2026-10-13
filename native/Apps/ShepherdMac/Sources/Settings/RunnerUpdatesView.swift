import ShepherdAppCore
import ShepherdKit
import SwiftUI

struct RunnerUpdatesIndicator: View {
    let model: RunnerUpdatesModel
    let serverName: String
    let sessions: [Session]
    @State private var showingDetails = false

    var body: some View {
        Group {
            if model.showsHerdr || model.showsCodex {
                HStack(spacing: 16) {
                    if model.showsHerdr {
                        Button { showingDetails = true } label: {
                            Label(indicator("herdr", current: model.herdr?.current, latest: model.herdr?.latest,
                                available: model.herdr?.updateAvailable == true), systemImage: "arrow.down.circle")
                        }.accessibilityIdentifier("runner-update-herdr")
                    }
                    if model.showsCodex {
                        Button { showingDetails = true } label: {
                            Label(indicator("Codex", current: model.codex?.current, latest: model.codex?.latest,
                                available: model.codex?.updateAvailable == true), systemImage: "arrow.down.circle")
                        }.accessibilityIdentifier("runner-update-codex")
                    }
                    Spacer(minLength: 0)
                }
                .font(.callout).buttonStyle(.borderless)
                .padding(.horizontal, 16).padding(.vertical, 8).background(.bar)
            }
        }
        .sheet(isPresented: $showingDetails) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text(verbatim: L.t("native_runner_title")).font(.headline)
                    Spacer()
                    Button(L.t("common_close")) { showingDetails = false }
                }
                ScrollView { RunnerUpdatesView(model: model, serverName: serverName, sessions: sessions) }
            }.padding(24).frame(width: 680, height: 600)
        }
    }
    private func indicator(_ runner: String, current: String?, latest: String?, available: Bool) -> String {
        available ? L.t("native_runner_indicator", runner, current ?? "—", latest ?? "—")
            : L.t("native_runner_attention", runner)
    }
}

struct RunnerUpdatesView: View {
    let model: RunnerUpdatesModel
    let serverName: String
    let sessions: [Session]
    @State private var confirmation: RunnerUpdateAction?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text(verbatim: L.t("native_runner_server", serverName))
                    .accessibilityIdentifier("runner-update-server")
                Spacer()
                Button(L.t("native_runner_refresh")) { model.refresh(); model.loadNotes() }
            }
            GroupBox("herdr") { herdrDetails.frame(maxWidth: .infinity, alignment: .leading) }
            GroupBox("Codex") { codexDetails.frame(maxWidth: .infinity, alignment: .leading) }
        }.padding(8)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("runner-update-details")
        .task { model.refresh(); model.loadNotes() }
        .onChange(of: model.codex?.current) { model.loadNotes() }
        .onChange(of: model.codex?.latest) { model.loadNotes() }
        .alert(L.t("native_runner_confirm"), isPresented: Binding(
            get: { confirmation != nil }, set: { if !$0 { confirmation = nil } }), presenting: confirmation) { action in
                Button(L.t("common_cancel"), role: .cancel) { confirmation = nil }
                Button(L.t("native_runner_proceed")) {
                    model.submit(action)
                    confirmation = nil
                }
            } message: { action in
                Text(L.t("native_runner_confirm_body", serverName) + "\n\n" +
                    (action.isCodex ? L.t("native_runner_codex_effect") : L.t("native_runner_herdr_effect")))
            }
    }

    private var herdrDetails: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let status = model.herdr {
                Text(verbatim: L.t("native_runner_indicator", "herdr", status.current ?? "—", status.latest ?? "—"))
                    .accessibilityIdentifier("runner-herdr-versions")
                if let error = status.error { Text(verbatim: error).foregroundStyle(.red) }
                if model.herdrActions.isEmpty && !model.showsHerdr && status.error == nil {
                    Text(verbatim: L.t("native_runner_no_update"))
                }
                if status.currentUnsupported == true { Text(verbatim: L.t("native_runner_current_unsupported")) }
                else if status.latestUnsupported == true { Text(verbatim: L.t("native_runner_unsupported")) }
                if let runtime = status.runtime {
                    Text(verbatim: L.t("native_runner_runtime", runtime.installedVersion ?? "—",
                        runtime.serverVersion ?? "—", runtimeState(runtime.state)))
                }
                if status.sandboxIdleRegressed == true && status.currentUnsupported != true && status.latestUnsupported != true {
                    Text(verbatim: L.t("native_runner_sandbox_advisory"))
                }
                Text(verbatim: L.t("native_runner_herdr_effect")).foregroundStyle(.secondary)
                if !sessions.isEmpty {
                    Text(verbatim: L.t("native_runner_tasks")).font(.headline)
                    ForEach(sessions, id: \.id) { Text(verbatim: $0.name).textSelection(.enabled) }
                }
                ForEach(Array(model.herdrActions.enumerated()), id: \.offset) { _, action in
                    Button(actionTitle(action)) { confirmation = action }
                        .disabled(!model.canRun(action))
                        .accessibilityIdentifier(actionID(action))
                }
                if let notes = status.notes, !notes.isEmpty {
                    DisclosureGroup(L.t("native_runner_notes")) { Text(verbatim: notes).textSelection(.enabled) }
                }
            } else { Text(verbatim: model.herdrError == nil ? L.t("native_runner_loading") : L.t("native_runner_failure")) }
            if let error = model.herdrError { Text(verbatim: error).foregroundStyle(.red) }
            progress(model.herdrProgress)
            Link(L.t("native_runner_releases"), destination: URL(string: "https://github.com/herdrdev/herdr/releases")!)
        }.padding(8)
    }

    private var codexDetails: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let status = model.codex {
                Text(verbatim: L.t("native_runner_indicator", "Codex", status.current ?? "—", status.latest ?? "—"))
                    .accessibilityIdentifier("runner-codex-versions")
                if let error = status.error { Text(verbatim: error).foregroundStyle(.red) }
                Text(verbatim: L.t("native_runner_codex_effect")).foregroundStyle(.secondary)
                if status.updateAvailable {
                    Button(L.t("native_runner_update")) { confirmation = .updateCodex }
                        .disabled(!model.canRun(.updateCodex)).accessibilityIdentifier("runner-codex-install")
                } else { Text(verbatim: L.t("native_runner_no_update")) }
            } else { Text(verbatim: model.codexError == nil ? L.t("native_runner_loading") : L.t("native_runner_failure")) }
            if let error = model.codexError { Text(verbatim: error).foregroundStyle(.red) }
            progress(model.codexProgress)
            DisclosureGroup(L.t("native_runner_notes")) {
                if model.notesLoading { ProgressView() }
                if let notes = model.notes {
                    ForEach(Array(notes.notes.enumerated()), id: \.offset) { _, note in
                        Text(verbatim: note.version).font(.headline)
                        Text(verbatim: note.body).textSelection(.enabled)
                    }
                    if !notes.complete { Text(verbatim: L.t("native_runner_notes_incomplete")) }
                } else if !model.notesLoading { Text(verbatim: L.t("native_runner_notes_incomplete")) }
                if let error = model.notesError { Text(verbatim: error).foregroundStyle(.secondary) }
            }
            Link(L.t("native_runner_releases"), destination: URL(string: "https://github.com/openai/codex/releases")!)
        }.padding(8)
    }
    @ViewBuilder private func progress(_ value: RunnerUpdateProgress) -> some View {
        if value.busy { ProgressView(L.t("native_runner_busy")) }
        if value.uncertain { Text(verbatim: L.t("native_runner_uncertain")).foregroundStyle(.orange) }
        if let success = value.succeeded {
            Text(verbatim: success ? L.t("native_runner_success") : L.t("native_runner_failure"))
                .foregroundStyle(success ? .green : .red)
        }
        if let error = value.error { Text(verbatim: error).foregroundStyle(.red).textSelection(.enabled) }
        if let binary = value.onPathBinary { Text(verbatim: L.t("native_runner_path", binary)).textSelection(.enabled) }
        if !value.log.isEmpty {
            DisclosureGroup(L.t("native_runner_log")) {
                Text(verbatim: value.log.joined(separator: "\n")).font(.caption.monospaced()).textSelection(.enabled)
            }
        }
    }
    static func runningSessions(_ sessions: [Session]) -> [Session] {
        sessions.filter { $0.status.known == .running || $0.status.known == .blocked }
    }
    private func actionTitle(_ action: RunnerUpdateAction) -> String {
        switch action {
        case .updateHerdr, .updateCodex: L.t("native_runner_update")
        case .downgradeHerdr: L.t("native_runner_downgrade", model.herdr?.downgradeTarget ?? "—")
        case .downgradeSandbox: L.t("native_runner_sandbox", model.herdr?.sandboxDowngradeTarget ?? "—")
        case .restartHerdr: L.t("native_runner_restart")
        }
    }
    private func actionID(_ action: RunnerUpdateAction) -> String {
        switch action {
        case .updateHerdr: "runner-herdr-install"
        case .downgradeHerdr: "runner-herdr-downgrade"
        case .downgradeSandbox: "runner-herdr-sandbox"
        case .restartHerdr: "runner-herdr-restart"
        case .updateCodex: "runner-codex-install"
        }
    }
    private func runtimeState(_ state: String) -> String {
        switch state {
        case "ready": L.t("native_runner_runtime_ready")
        case "restart_required": L.t("native_runner_runtime_restart")
        case "offline": L.t("native_runner_runtime_offline")
        case "unknown": L.t("native_runner_runtime_unknown")
        default: state
        }
    }
}
