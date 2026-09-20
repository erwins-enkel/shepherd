import Foundation
import Observation
import ShepherdKit
import SwiftUI

@MainActor
struct DoneReads {
    var sessions: () async throws -> [Session]
    var recaps: () async throws -> [String: Recap]

    static func live(_ client: ShepherdClient) -> Self {
        Self(sessions: { try await client.doneSessions() }, recaps: { try await client.recaps() })
    }
}

@Observable
@MainActor
final class DonePanelState {
    private(set) var sessions: [Session] = []
    private(set) var recaps: [String: Recap] = [:]
    private(set) var isLoading = false
    private(set) var error: String?
    private var generation = 0

    func reload(_ reads: DoneReads, isCurrent: () -> Bool = { true }) async {
        generation &+= 1
        let mine = generation
        isLoading = true
        error = nil
        do {
            let rows = try await reads.sessions()
            let summaries = try await reads.recaps()
            guard mine == generation, !Task.isCancelled, isCurrent() else { return }
            sessions = DonePresentation.sorted(rows)
            // session:archived drops the store's recap; the post-archive session:recap
            // finalise frame adds it back. Never blacklist archived ids from this map.
            recaps = summaries
        } catch {
            guard mine == generation, !Task.isCancelled, isCurrent() else { return }
            self.error = ShepherdErrorCopy.message(error)
        }
        isLoading = false
    }

    func close() {
        generation &+= 1
        isLoading = false
        sessions = []
        recaps = [:]
        error = nil
    }
}

enum DonePresentation {
    static let recapFeatureEpochMS = 1_781_423_073_000

    static func sorted(_ sessions: [Session]) -> [Session] {
        // The server applies the 48-hour window. Do not discard its rows using the local clock.
        sessions.sorted {
            let left = $0.archivedAt ?? $0.updatedAt
            let right = $1.archivedAt ?? $1.updatedAt
            return left == right ? $0.id < $1.id : left > right
        }
    }

    static func nextSelectedID(_ sessions: [Session], selectedID: String?) -> String? {
        sessions.contains { $0.id == selectedID } ? selectedID : sessions.first?.id
    }

    static func verdict(_ recap: Recap?) -> RecapVerdict? {
        recap?.state.known == .ready ? recap?.verdict : nil
    }

    static func snippet(_ session: Session, recap: Recap?) -> String {
        recap?.state.known == .ready ? recap?.headline ?? ""
            : session.name.isEmpty ? session.prompt : session.name
    }

    static func repoBasename(_ path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }

    static func emptyCopy(_ session: Session, recap: Recap?) -> String {
        if recap?.state.known == .empty { return L.t("recap_empty_legacy") }
        if recap == nil, (session.archivedAt ?? session.updatedAt) < recapFeatureEpochMS {
            return L.t("recap_predates_feature")
        }
        return L.t("recap_unavailable")
    }

    static func finished(_ session: Session, now: Date) -> String {
        let elapsed = max(0, now.timeIntervalSince1970 - Double(session.archivedAt ?? session.updatedAt) / 1_000)
        let formatter = DateComponentsFormatter()
        formatter.unitsStyle = .abbreviated
        formatter.allowedUnits = elapsed >= 86_400 ? [.day] : elapsed >= 3_600 ? [.hour] : [.minute]
        return L.t("done_recap_finished", formatter.string(from: elapsed) ?? "—")
    }

    // Recap's current contract subset preserves failure in generated additionalProperties.
    // No second payload decoder/type: S8 can replace these lookups when it expands Recap.
    static func failureField(_ recap: Recap, _ field: String) -> String? {
        let failure = recap.additionalProperties.value["failure"] as? [String: (any Sendable)?]
        return failure?[field] as? String
    }

    static func failureHeadline(_ recap: Recap) -> String {
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

    static func failureAction(_ recap: Recap) -> String {
        switch failureField(recap, "code") {
        case "auth-unavailable": L.t("recap_failure_auth_action")
        case "source-unavailable": L.t("recap_failure_source_action")
        default: L.t("recap_failure_provider_action")
        }
    }
}

struct DoneVerdictChip: View {
    let verdict: RecapVerdict

    private var label: String {
        switch verdict.known {
        case .ready: L.t("recap_verdict_ready")
        case .parked: L.t("recap_verdict_parked")
        case .needsAttention: L.t("recap_verdict_needs_attention")
        case nil: verdict.rawValue
        }
    }

    private var tint: Color {
        switch verdict.known {
        case .ready: .green
        case .parked: SessionStatusStyle.tint(.init(known: .done))
        case .needsAttention: .orange
        case nil: .secondary
        }
    }

    var body: some View {
        Text(verbatim: label)
            .font(.caption.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(tint.opacity(0.12), in: Capsule())
    }
}

/// This panel owns its selection: archived rows have already left store.sessions, so
/// AppModel.selectedSessionID would resolve to nothing. The integration lane mounts it as a lens.
struct DonePanelView: View {
    @Environment(AppModel.self) private var app
    @State private var state = DonePanelState()
    @State private var doneSelectedID: String?
    @State private var refreshID = 0

    var body: some View {
        Group {
            if state.isLoading {
                ProgressView(L.t("common_loading"))
            } else if let error = state.error {
                VStack {
                    Text(verbatim: error)
                    Button(L.t("common_retry")) { refreshID &+= 1 }
                }
            } else if state.sessions.isEmpty {
                Text(L.t("herd_done_empty")).foregroundStyle(.secondary)
            } else {
                HSplitView {
                    List(state.sessions, id: \.id, selection: $doneSelectedID) { session in
                        row(session).tag(session.id)
                    }
                    .frame(minWidth: 240, idealWidth: 320)
                    .accessibilityIdentifier("queues-done-list")
                    if let selected = state.sessions.first(where: { $0.id == doneSelectedID }),
                       let client = app.store?.client {
                        DoneRecapView(session: selected, recap: state.recaps[selected.id],
                                      loadUsage: { try await client.sessionUsage(id: $0) })
                            .id(ObjectIdentifier(client))
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("queues-done-panel")
        // .task runs again on every appearance, even if the activation/refresh ids did not change.
        .task(id: "\(app.activationGeneration):\(refreshID)") {
            let generation = app.activationGeneration
            guard let client = app.store?.client else { state.close(); return }
            await state.reload(.live(client), isCurrent: { app.activationGeneration == generation })
            guard !Task.isCancelled, app.activationGeneration == generation else { return }
            doneSelectedID = DonePresentation.nextSelectedID(state.sessions, selectedID: doneSelectedID)
        }
        .onDisappear { state.close() }
    }

    private func row(_ session: Session) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(verbatim: session.desig).fontWeight(.semibold)
                Text(verbatim: DonePresentation.repoBasename(session.repoPath))
                    .foregroundStyle(.secondary).lineLimit(1)
                if let verdict = DonePresentation.verdict(state.recaps[session.id]) {
                    DoneVerdictChip(verdict: verdict)
                }
            }
            TimelineView(.periodic(from: .now, by: 30)) { context in
                Text(verbatim: DonePresentation.finished(session, now: context.date))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Text(verbatim: DonePresentation.snippet(session, recap: state.recaps[session.id]))
                .lineLimit(2)
        }
        .padding(.vertical, 4)
        .accessibilityIdentifier("queues-done-row-\(session.id)")
    }
}
