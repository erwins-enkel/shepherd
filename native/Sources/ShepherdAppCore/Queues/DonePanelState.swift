import Foundation
import Observation
import ShepherdKit
import SwiftUI

@MainActor
public struct DoneReads {
    var sessions: () async throws -> [Session]
    var recaps: () async throws -> [String: Recap]

    public static func live(_ client: ShepherdClient) -> Self {
        Self(sessions: { try await client.doneSessions() }, recaps: { try await client.recaps() })
    }
}

@Observable
@MainActor
public final class DonePanelState {
    public init() {}

    public private(set) var sessions: [Session] = []
    private(set) var recaps: [String: Recap] = [:]
    public private(set) var isLoading = false
    public private(set) var error: String?
    private var generation = 0
    private var lifetime = 0
    private var activation: Int?

    public func reload(_ reads: DoneReads, isCurrent: () -> Bool = { true }) async {
        generation &+= 1
        let mine = generation
        isLoading = true
        error = nil
        do {
            let rows = try await reads.sessions()
            let summaries = try await reads.recaps()
            guard mine == generation, !Task.isCancelled, isCurrent() else { return }
            sessions = DonePresentation.sorted(rows)
            // A live finalisation may arrive during a read or outlive S4's pruning.
            // Keep the newest recap in our own snapshot, bounded by the Done rows.
            var merged = summaries
            for (id, cached) in recaps where cached.updatedAt >= (merged[id]?.updatedAt ?? -1) {
                merged[id] = cached
            }
            let ids = Set(rows.map(\.id))
            recaps = merged.filter { ids.contains($0.key) }
        } catch {
            guard mine == generation, !Task.isCancelled, isCurrent() else { return }
            self.error = ShepherdErrorCopy.message(error)
        }
        isLoading = false
    }

    public func recap(for id: String, actions: ActionsModel?) -> Recap? {
        // S4 may deliver first, but our independent tap retains finalisations after
        // its live-only map prunes archived ids on reconnect.
        let snapshot = recaps[id]
        guard let live = actions?.recaps[id] else { return snapshot }
        if let snapshot, snapshot.updatedAt > live.updatedAt { return snapshot }
        return live
    }

    public func prepare(activation next: Int) {
        guard activation != next else { return }
        close()
        activation = next
    }

    public func follow(_ events: AsyncStream<ServerEvent>, isCurrent: () -> Bool = { true }) async {
        let mine = lifetime
        for await event in events {
            guard mine == lifetime, !Task.isCancelled, isCurrent() else { return }
            apply(event)
        }
    }

    func apply(_ event: ServerEvent) {
        guard case .unknown(let name, let payload) = event, name == "session:recap",
              let payload,
              let frame = try? JSONDecoder().decode(Components.Schemas.SessionRecapEvent.self,
                                                    from: payload),
              frame.recap.updatedAt >= (recaps[frame.id]?.updatedAt ?? -1) else { return }
        recaps[frame.id] = frame.recap
    }

    public func close() {
        generation &+= 1
        lifetime &+= 1
        isLoading = false
        sessions = []
        recaps = [:]
        error = nil
    }
}

public enum DonePresentation {
    public static func archiveReason(_ reason: Components.Schemas.SessionArchiveReason?) -> String {
        switch reason?.known {
        case ._operator: L.t("done_recap_archive_operator")
        case .merged: L.t("done_recap_archive_merged")
        case .drain: L.t("done_recap_archive_drain")
        case .relaunch: L.t("done_recap_archive_relaunch")
        case .stale: L.t("done_recap_archive_stale")
        case nil: L.t("done_recap_archive_unknown")
        }
    }

    static let recapFeatureEpochMS = 1_781_423_073_000

    static func sorted(_ sessions: [Session]) -> [Session] {
        // The server applies the 48-hour window. Do not discard its rows using the local clock.
        sessions.sorted {
            let left = $0.archivedAt ?? $0.updatedAt
            let right = $1.archivedAt ?? $1.updatedAt
            return left == right ? $0.id < $1.id : left > right
        }
    }

    public static func filtered(_ sessions: [Session], repos: Set<String>) -> [Session] {
        repos.isEmpty ? sessions : sessions.filter { repos.contains($0.repoPath) }
    }

    public static func nextSelectedID(_ sessions: [Session], selectedID: String?) -> String? {
        sessions.contains { $0.id == selectedID } ? selectedID : sessions.first?.id
    }

    public static func verdict(_ recap: Recap?) -> RecapVerdict? {
        recap?.state.known == .ready ? recap?.verdict : nil
    }

    public static func snippet(_ session: Session, recap: Recap?) -> String {
        recap?.state.known == .ready ? recap?.headline ?? ""
            : session.name.isEmpty ? session.prompt : session.name
    }

    public static func repoBasename(_ path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }

    public static func emptyCopy(_ session: Session, recap: Recap?) -> String {
        if recap?.state.known == .empty { return L.t("recap_empty_legacy") }
        if recap == nil, (session.archivedAt ?? session.updatedAt) < recapFeatureEpochMS {
            return L.t("recap_predates_feature")
        }
        return L.t("recap_unavailable")
    }

    public static func finished(_ session: Session, now: Date) -> String {
        let elapsed = max(0, now.timeIntervalSince1970 - Double(session.archivedAt ?? session.updatedAt) / 1_000)
        let formatter = DateComponentsFormatter()
        formatter.unitsStyle = .abbreviated
        formatter.allowedUnits = elapsed >= 86_400 ? [.day] : elapsed >= 3_600 ? [.hour] : [.minute]
        return L.t("done_recap_finished", formatter.string(from: elapsed) ?? "—")
    }

    // Recap's current contract subset preserves failure in generated additionalProperties.
    // No second payload decoder/type: S8 can replace these lookups when it expands Recap.
    public static func failureField(_ recap: Recap, _ field: String) -> String? {
        let failure = recap.additionalProperties.value["failure"] as? [String: (any Sendable)?]
        return failure?[field] as? String
    }

    public static func failureHeadline(_ recap: Recap) -> String {
        switch failureField(recap, "code") {
        case "auth-unavailable": L.t("recap_failure_auth_headline")
        case "source-unavailable": L.t("recap_failure_source_headline")
        case "launch-failed": L.t("recap_failure_launch_headline")
        case "timed-out": L.t("recap_failure_timeout_headline")
        case "no-result": L.t("recap_failure_no_result_headline")
        case "invalid-result": L.t("recap_failure_invalid_result_headline")
        default: L.t("recap_failed")
        }
    }

    public static func failureAction(_ recap: Recap) -> String {
        switch failureField(recap, "code") {
        case "auth-unavailable": L.t("recap_failure_auth_action")
        case "source-unavailable": L.t("recap_failure_source_action")
        default: L.t("recap_failure_provider_action")
        }
    }
}

@Observable
@MainActor
public final class DoneUsageState {
    public init() {}

    private final class Request {
        var alive = true
    }

    private var request: Request?
    private(set) var usage: Components.Schemas.SessionUsage?

    public var display: String {
        guard let usage, usage.available else { return "—" }
        return usage.total.formatted()
    }

    public func load(id: String, read: (String) async throws -> Components.Schemas.SessionUsage) async {
        close()
        let mine = Request()
        request = mine
        let result = try? await read(id)
        // Cancellation alone cannot fence a transport that completes after row selection changes.
        guard mine.alive, !Task.isCancelled else { return }
        usage = result
    }

    public func close() {
        request?.alive = false
        request = nil
        usage = nil
    }
}

public struct DoneRestoreConfirmation {
    public init() {}

    public private(set) var armedUntil: Int?
    public var isArmed: Bool { armedUntil != nil }

    public mutating func tap(now: Int) -> Bool {
        if let armedUntil, now < armedUntil {
            disarm()
            return true
        }
        armedUntil = now + 3_000
        return false
    }

    public mutating func disarm() { armedUntil = nil }
}
