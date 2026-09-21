import Foundation
import Observation
import ShepherdKit
import SwiftUI

public enum QueueActionPresentation {
    public static func haltable(_ sessions: [Session]) -> Set<String> {
        Set(sessions.filter { $0.status.known == .running }.map(\.id))
    }

    public static func strandedMessage(_ ids: Set<String>) -> String? {
        ids.isEmpty ? nil : L.t("toast_sessions_stranded", String(ids.count))
    }

    public struct OwedEntry: Identifiable {
        public let id: String
        public let count: Int
    }

    public static func owed(_ counts: [String: Int]) -> [OwedEntry] {
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
public struct QueueHaltConfirmation {
    public init() {}

    private var ids: Set<String> = []
    private var confirmation = DoneRestoreConfirmation()
    public var isArmed: Bool { confirmation.isArmed }
    public var armedUntil: Int? { confirmation.armedUntil }

    public mutating func tap(sessions: [Session], now: Int) -> Bool {
        let current = QueueActionPresentation.haltable(sessions)
        if current != ids { disarm(); ids = current }
        guard !current.isEmpty else { disarm(); return false }
        return confirmation.tap(now: now)
    }

    public mutating func disarm() { confirmation.disarm(); ids = [] }
}

/// Created by the sheet at presentation, never reseeded by an event observer.
public struct QueueTargetSelection {
    public var selected: Set<String>

    public init(sessions: [Session], preselectUsage: Bool) {
        selected = preselectUsage
            ? Set(sessions.filter { $0.haltReason?.rawValue == "usage_limit" }.map(\.id)) : []
    }

    public mutating func toggle(_ id: String) {
        if !selected.insert(id).inserted { selected.remove(id) }
    }

    public func ids(in sessions: [Session]) -> [String] {
        sessions.filter { selected.contains($0.id) }.map(\.id).sorted()
    }
}

public enum QueueAction {
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
public struct QueueActionCommands {
    var halt: () async throws -> HaltResult
    var retry: ([String], String) async throws -> RetryResult
    var revive: () async throws -> ReviveResult
    var restore: (String) async throws -> Session
    var broadcast: ([String], String) async throws -> BroadcastResult
    var reloadStranded: () async throws -> Void

    public static func live(_ client: ShepherdClient, model: QueuesModel?) -> Self {
        .init(halt: {
            let result = try await client.halt()
            model?.recordHaltDone(result)
            return result
        },
              retry: { try await client.retry(ids: $0, text: $1) },
              revive: { try await client.reviveStranded() },
              restore: { try await client.restore(sessionID: $0) },
              broadcast: { try await client.broadcast(ids: $0, text: $1) },
              reloadStranded: { try await model?.reloadStranded() })
    }
}

@Observable
@MainActor
public final class QueueActionState {
    public init() {}

    public let gate = SessionCommandState()
    public private(set) var notices: [String] = []
    private struct NoDelivery: Error {}

    public func clear() { gate.clear(); notices = [] }

    @discardableResult
    public func run(_ action: QueueAction, commands: QueueActionCommands,
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
