import ShepherdAppCore
import Foundation
import Observation
import ShepherdKit
import SwiftUI

/// Mountable by the integration lane; no shared toolbar or registry is modified here.
struct QueueActionsView: View {
    @Environment(AppModel.self) private var app
    let model: QueuesModel
    @State private var halt = QueueActionState()
    @State private var revive = QueueActionState()
    @State private var sheetResult: [String] = []
    @State private var confirmation = QueueHaltConfirmation()
    @State private var sheet: TargetSheet?
    @State private var presentation = 0

    private struct TargetSheet: Identifiable {
        let id = UUID()
        let retry: Bool
        let sessions: [Session]
    }

    private var sessions: [Session] { app.store?.sessions ?? [] }
    private var haltable: Set<String> { QueueActionPresentation.haltable(sessions) }

    var body: some View {
        let runHalt = runner(halt)
        let runRevive = runner(revive)
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Button(halt.gate.busy ? L.t("halt_confirm", String(haltable.count))
                       : confirmation.isArmed ? L.t("halt_arm", String(haltable.count))
                       : L.t("halt_menu_item", String(haltable.count)), role: .destructive) {
                    if confirmation.tap(sessions: sessions, now: Int(Date.now.timeIntervalSince1970 * 1_000)) {
                        Task { await runHalt(.halt) }
                    }
                }
                .disabled(haltable.isEmpty || halt.gate.busy)
                .accessibilityLabel(confirmation.isArmed ? L.t("halt_arm_aria", String(haltable.count))
                                    : L.t("halt_all_aria", String(haltable.count)))
                .accessibilityIdentifier("queues-halt")
                Button(L.t("retry_title")) { sheet = TargetSheet(retry: true, sessions: model.retrySessions) }
                    .accessibilityIdentifier("queues-retry")
                Button(L.t("broadcast_title")) { sheet = TargetSheet(retry: false, sessions: sessions) }
                    .accessibilityIdentifier("queues-broadcast")
            }
            QueueActionNotices(state: halt, retry: { Task { await runHalt(.halt) } }, showsNotices: false)
            if let result = model.haltDoneNotice {
                NoticeBar(message: L.t("halt_done", String(result.halted)), tone: .success,
                          onDismiss: model.dismissHaltDone)
                    .accessibilityIdentifier("queues-halt-done")
            }
            if let message = QueueActionPresentation.strandedMessage(model.stranded) {
                HStack {
                    Text(verbatim: message)
                    Button(L.t("toast_revive_all")) { Task { await runRevive(.revive) } }
                        .disabled(revive.gate.busy)
                        .accessibilityIdentifier("queues-revive-all")
                }
                .accessibilityIdentifier("queues-stranded-banner")
            }
            QueueActionNotices(state: revive)
            if let result = model.autoRevivedNotice {
                NoticeBar(message: L.t("toast_auto_revived", String(result.revived), String(result.failed)),
                          tone: result.failed > 0 ? .warning : .success,
                          onDismiss: model.dismissAutoRevived)
                    .accessibilityIdentifier("queues-auto-revived")
            }
            ForEach(sheetResult, id: \.self) { message in
                NoticeBar(message: message, tone: .success) { sheetResult = [] }
            }
        }
        .accessibilityIdentifier("queues-actions")
        .sheet(item: $sheet) { target in
            if let client = app.store?.client {
                QueueTargetsSheet(retry: target.retry, initialSessions: target.sessions,
                    commands: .live(client, model: model), activation: app.activationGeneration) { sheetResult = $0 }
                    .id(target.id)
            }
        }
        .task(id: confirmation.armedUntil) {
            guard confirmation.isArmed else { return }
            do { try await Task.sleep(for: .seconds(3)) } catch { return }
            confirmation.disarm()
        }
        .onChange(of: haltable) { _, _ in confirmation.disarm() }
        .onChange(of: app.activationGeneration) { _, _ in reset() }
        .onDisappear { reset() }
    }

    private func reset() {
        presentation &+= 1
        confirmation.disarm()
        sheet = nil
        sheetResult = []
        halt.clear()
        revive.clear()
    }

    private func runner(_ state: QueueActionState) -> @MainActor (QueueAction) async -> Void {
        let activation = app.activationGeneration
        let shown = presentation
        let client = app.store?.client
        return { action in
            guard let client else { return }
            await state.run(action, commands: .live(client, model: model),
                isCurrent: { app.activationGeneration == activation && presentation == shown })
        }
    }
}

struct QueueActionNotices: View {
    let state: QueueActionState
    var retry: (() -> Void)?
    var showsNotices = true

    var body: some View {
        if let message = state.gate.message {
            HStack {
                // No timer: a failed halt remains actionable until retry or explicit dismissal.
                NoticeBar(message: message, onDismiss: state.clear)
                if let retry {
                    Button(L.t("common_retry"), action: retry).disabled(state.gate.busy)
                        .accessibilityIdentifier("queues-action-retry")
                }
            }
        }
        if showsNotices {
            ForEach(state.notices, id: \.self) { message in
                NoticeBar(message: message, tone: .success, onDismiss: state.clear)
            }
        }
    }
}

private struct QueueTargetsSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let retry: Bool
    let commands: QueueActionCommands
    let activation: Int
    let completed: ([String]) -> Void
    @State private var selection: QueueTargetSelection
    @State private var text = ""
    @State private var state = QueueActionState()
    @State private var confirmation = DoneRestoreConfirmation()
    @State private var presentation = 0

    init(retry: Bool, initialSessions: [Session], commands: QueueActionCommands, activation: Int,
         completed: @escaping ([String]) -> Void) {
        self.retry = retry
        self.commands = commands
        self.activation = activation
        self.completed = completed
        _selection = State(initialValue: QueueTargetSelection(sessions: initialSessions, preselectUsage: retry))
    }

    private var sessions: [Session] {
        // Flags stay live, but the @State selection is seeded only once by init.
        if retry, let model = app.extension(QueuesModel.self) { return model.retrySessions }
        return app.store?.sessions ?? []
    }
    private var ids: [String] { selection.ids(in: sessions) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(retry ? L.t("retry_title") : L.t("broadcast_title")).font(.title2)
            HStack {
                Text(L.t("broadcast_targets"))
                Spacer()
                Button(L.t("broadcast_select_all")) { selection.selected = Set(sessions.map(\.id)) }
                Button(L.t("broadcast_clear_all")) { selection.selected = [] }
            }
            if sessions.isEmpty {
                Text(retry ? L.t("retry_empty") : L.t("broadcast_no_sessions"))
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading) {
                        ForEach(sessions, id: \.id) { session in
                            Toggle(isOn: Binding(get: { selection.selected.contains(session.id) },
                                set: { _ in selection.toggle(session.id) })) {
                                    Text(verbatim: "\(session.desig) · \(session.name)")
                                    if retry && session.haltReason?.rawValue == "usage_limit" {
                                        Text(L.t("retry_halted_badge")).font(.caption)
                                    }
                            }
                            .accessibilityIdentifier("queues-target-\(session.id)")
                        }
                    }
                }.frame(maxHeight: 280)
            }
            if !retry {
                Text(L.t("broadcast_steer"))
                TextEditor(text: $text).frame(height: 100)
                    .accessibilityLabel(L.t("broadcast_textarea_aria"))
                    .accessibilityIdentifier("queues-broadcast-text")
            }
            QueueActionNotices(state: state)
            HStack {
                Button(L.t("common_cancel")) { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button(sendLabel) { send() }
                    .disabled(ids.isEmpty || (!retry && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                    .accessibilityIdentifier("queues-target-send")
            }
        }
        .disabled(state.gate.busy)
        .padding(24).frame(width: 540)
        .interactiveDismissDisabled(state.gate.busy)
        .accessibilityIdentifier(retry ? "queues-retry-sheet" : "queues-broadcast-sheet")
        .onChange(of: ids) { _, _ in confirmation.disarm() }
        .onChange(of: text) { _, _ in confirmation.disarm() }
        .onChange(of: app.activationGeneration) { _, _ in presentation &+= 1; dismiss() }
        .onDisappear { presentation &+= 1; confirmation.disarm() }
        .task(id: confirmation.armedUntil) {
            guard confirmation.isArmed else { return }
            do { try await Task.sleep(for: .seconds(3)) } catch { return }
            confirmation.disarm()
        }
    }

    private var sendLabel: String {
        if state.gate.busy { return L.t("broadcast_sending") }
        if retry { return confirmation.isArmed ? L.t("retry_arm", String(ids.count)) : L.t("retry_confirm", String(ids.count)) }
        return confirmation.isArmed ? L.t("broadcast_confirm_send", String(ids.count)) : L.t("broadcast_send_to", String(ids.count))
    }

    private func send() {
        guard confirmation.tap(now: Int(Date.now.timeIntervalSince1970 * 1_000)) else { return }
        let action: QueueAction = retry ? .retry(ids) : .broadcast(ids, text)
        let shown = presentation
        Task {
            if await state.run(action, commands: commands,
                isCurrent: { app.activationGeneration == activation && presentation == shown }) {
                completed(state.notices)
                dismiss()
            }
        }
    }
}

/// S9 supplies the counts, including archived sessions absent from the live store.
/// The seam has no manual-step text or acknowledgement operation; expose exactly its facts.
struct OwedPanelView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let rows = QueueActionPresentation.owed(SessionSignals.manualStepsOutstanding())
        VStack(alignment: .leading, spacing: 12) {
            Text(L.t("owed_title")).font(.headline)
            if rows.isEmpty {
                Text(L.t("owed_empty")).foregroundStyle(.secondary)
            } else {
                List(rows) { row in
                    let session = app.store?.sessions.first { $0.id == row.id }
                    HStack {
                        Text(verbatim: session.map { "\($0.desig) · \($0.name)" } ?? row.id)
                        Spacer()
                        Text(verbatim: row.count.formatted()).monospacedDigit()
                    }
                    .accessibilityIdentifier("queues-owed-row-\(row.id)")
                }
            }
        }
        .padding().frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("queues-owed-panel")
    }
}
