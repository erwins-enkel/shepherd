import Foundation
import Observation
import ShepherdKit
import SwiftUI

enum QueueActionPresentation {
    static func haltable(_ sessions: [Session]) -> Set<String> {
        Set(sessions.filter { $0.status.known == .running }.map(\.id))
    }

    static func strandedMessage(_ ids: Set<String>) -> String? {
        ids.isEmpty ? nil : L.t("toast_sessions_stranded", String(ids.count))
    }

    struct OwedEntry: Identifiable {
        let id: String
        let count: Int
    }

    static func owed(_ counts: [String: Int]) -> [OwedEntry] {
        counts.filter { $0.value > 0 }.sorted { $0.key < $1.key }
            .map { OwedEntry(id: $0.key, count: $0.value) }
    }

    static func restoreFailure(_ conflict: RestoreConflict) -> String {
        switch conflict.code.rawValue {
        case "in_progress": L.t("restore_in_progress")
        case "not_archived": L.t("restore_not_archived")
        case "cannot_restore": L.t("restore_cannot")
        case "branch_gone": L.t("restore_branch_gone")
        case "branch_in_use": L.t("restore_branch_in_use")
        default: L.t("restore_failed")
        }
    }
}

/// A changed haltable set needs a new arm, even when its count has not changed.
struct QueueHaltConfirmation {
    private var ids: Set<String> = []
    private var confirmation = DoneRestoreConfirmation()
    var isArmed: Bool { confirmation.isArmed }
    var armedUntil: Int? { confirmation.armedUntil }

    mutating func tap(sessions: [Session], now: Int) -> Bool {
        let current = QueueActionPresentation.haltable(sessions)
        if current != ids { disarm(); ids = current }
        guard !current.isEmpty else { disarm(); return false }
        return confirmation.tap(now: now)
    }

    mutating func disarm() { confirmation.disarm(); ids = [] }
}

/// Created by the sheet at presentation, never reseeded by an event observer.
struct QueueTargetSelection {
    var selected: Set<String>

    init(sessions: [Session], preselectUsage: Bool) {
        selected = preselectUsage
            ? Set(sessions.filter { $0.haltReason?.rawValue == "usage_limit" }.map(\.id)) : []
    }

    mutating func toggle(_ id: String) {
        if !selected.insert(id).inserted { selected.remove(id) }
    }

    func ids(in sessions: [Session]) -> [String] {
        sessions.filter { selected.contains($0.id) }.map(\.id).sorted()
    }
}

enum QueueAction {
    case halt
    case retry([String])
    case revive
    case restore(Session)
    case broadcast([String], String)

    var failureCopy: String {
        switch self {
        case .halt: L.t("halt_failed")
        case .retry: L.t("retry_failed")
        case .revive: L.t("toast_revive_all_failed")
        case .restore: L.t("restore_failed")
        case .broadcast: L.t("broadcast_failed")
        }
    }

    var isValid: Bool {
        switch self {
        case .retry(let ids): !ids.isEmpty
        case .broadcast(let ids, let text):
            !ids.isEmpty && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        default: true
        }
    }
}

/// Generated payloads remain the only wire types. This is just an injectable command boundary.
@MainActor
struct QueueActionCommands {
    var halt: () async throws -> HaltResult
    var retry: ([String], String) async throws -> RetryResult
    var revive: () async throws -> ReviveResult
    var restore: (String) async throws -> Session
    var broadcast: ([String], String) async throws -> BroadcastResult
    var reloadStranded: () async throws -> Void

    static func live(_ client: ShepherdClient, model: QueuesModel?) -> Self {
        .init(halt: { try await client.halt() },
              retry: { try await client.retry(ids: $0, text: $1) },
              revive: { try await client.reviveStranded() },
              restore: { try await client.restore(sessionID: $0) },
              broadcast: { try await client.broadcast(ids: $0, text: $1) },
              reloadStranded: { try await model?.reloadStranded() })
    }
}

@Observable
@MainActor
final class QueueActionState {
    let gate = SessionCommandState()
    private(set) var notices: [String] = []
    private struct NoDelivery: Error {}

    func clear() { gate.clear(); notices = [] }

    @discardableResult
    func run(_ action: QueueAction, commands: QueueActionCommands,
             isCurrent: () -> Bool) async -> Bool {
        guard isCurrent(), !Task.isCancelled, !gate.busy, action.isValid else { return false }
        notices = []
        var result: [String] = []
        var failure = action.failureCopy
        let succeeded = await gate.run({
            do {
                switch action {
                case .halt:
                    let response = try await commands.halt()
                    result = [L.t("halt_done", String(response.halted))]
                case .retry(let ids):
                    let response = try await commands.retry(ids, L.t("retry_continue_steer"))
                    result = [L.t("toast_retry_done", String(response.resumed), String(response.steered), String(response.total))]
                case .revive:
                    let response = try await commands.revive()
                    guard isCurrent(), !Task.isCancelled else { return }
                    try await commands.reloadStranded()
                    result = [L.t("toast_revive_all_result", String(response.revived), String(response.failed))]
                case .restore(let session):
                    let response = try await commands.restore(session.id)
                    result = [L.t("restore_done", response.desig)]
                case .broadcast(let ids, let text):
                    let response = try await commands.broadcast(ids, text.trimmingCharacters(in: .whitespacesAndNewlines))
                    guard response.delivered + response.queued > 0
                            || (response.skipped > 0 && response.offline == 0) else { throw NoDelivery() }
                    if response.delivered + response.queued > 0 {
                        result.append(response.queued == 0 && response.offline == 0
                            ? L.t("toast_broadcast_delivered", String(response.delivered))
                            : L.t("toast_broadcast_result", String(response.delivered), String(response.queued), String(response.offline)))
                    }
                    if response.skipped > 0 { result.append(L.t("toast_broadcast_skipped_terminals", String(response.skipped))) }
                }
            } catch let conflict as RestoreConflict {
                failure = QueueActionPresentation.restoreFailure(conflict)
                throw conflict
            }
        }, failureCopy: { _ in failure }, isCurrent: { isCurrent() && !Task.isCancelled })
        guard succeeded, isCurrent(), !Task.isCancelled else { return false }
        notices = result
        return true
    }
}

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
            QueueActionNotices(state: halt, retry: { Task { await runHalt(.halt) } })
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
        ForEach(state.notices, id: \.self) { message in
            NoticeBar(message: message, tone: .success, onDismiss: state.clear)
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

    private var sessions: [Session] { app.store?.sessions ?? [] }
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
        .accessibilityIdentifier("queues-owed-panel")
    }
}
