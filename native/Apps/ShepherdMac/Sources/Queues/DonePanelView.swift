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
    private var lifetime = 0
    private var activation: Int?

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

    func recap(for id: String, actions: ActionsModel?) -> Recap? {
        // S4 may deliver first, but our independent tap retains finalisations after
        // its live-only map prunes archived ids on reconnect.
        let snapshot = recaps[id]
        guard let live = actions?.recaps[id] else { return snapshot }
        if let snapshot, snapshot.updatedAt > live.updatedAt { return snapshot }
        return live
    }

    func prepare(activation next: Int) {
        guard activation != next else { return }
        close()
        activation = next
    }

    func follow(_ events: AsyncStream<ServerEvent>, isCurrent: () -> Bool = { true }) async {
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

    func close() {
        generation &+= 1
        lifetime &+= 1
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

    static func filtered(_ sessions: [Session], repos: Set<String>) -> [Session] {
        repos.isEmpty ? sessions : sessions.filter { repos.contains($0.repoPath) }
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
    @State private var restore = QueueActionState()
    @State private var presentation = 0

    private var shownSessions: [Session] {
        DonePresentation.filtered(state.sessions, repos: app.extension(SidebarModel.self)?.activeRepos ?? [])
    }

    private func recap(for id: String) -> Recap? {
        state.recap(for: id, actions: app.extension(ActionsModel.self))
    }

    var body: some View {
        Group {
            if state.isLoading {
                ProgressView(L.t("common_loading"))
            } else if let error = state.error {
                VStack {
                    Text(verbatim: error)
                    Button(L.t("common_retry")) { refreshID &+= 1 }
                }
            } else if shownSessions.isEmpty {
                Text(L.t("herd_done_empty")).foregroundStyle(.secondary)
            } else {
                HSplitView {
                    List(shownSessions, id: \.id, selection: $doneSelectedID) { session in
                        row(session).tag(session.id)
                    }
                    .frame(minWidth: 240, idealWidth: 320)
                    .accessibilityIdentifier("queues-done-list")
                    if let selected = shownSessions.first(where: { $0.id == doneSelectedID }),
                       let client = app.store?.client {
                        DoneRecapView(session: selected, recap: recap(for: selected.id),
                                      loadUsage: { try await client.sessionUsage(id: $0) },
                                      bringBack: restore.gate.busy ? nil : restoreAction(selected, client: client))
                            .id(ObjectIdentifier(client))
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("queues-done-panel")
        .safeAreaInset(edge: .top) { QueueActionNotices(state: restore) }
        .onChange(of: app.activationGeneration) { _, _ in presentation &+= 1; restore.clear() }
        // .task runs again on every appearance, even if the activation/refresh ids did not change.
        .task(id: "\(app.activationGeneration):\(refreshID)") {
            let generation = app.activationGeneration
            state.prepare(activation: generation)
            guard let client = app.store?.client else { state.close(); return }
            await state.reload(.live(client), isCurrent: { app.activationGeneration == generation })
            guard !Task.isCancelled, app.activationGeneration == generation else { return }
            doneSelectedID = DonePresentation.nextSelectedID(shownSessions, selectedID: doneSelectedID)
        }
        .task(id: app.activationGeneration) {
            let generation = app.activationGeneration
            state.prepare(activation: generation)
            guard let store = app.store else { return }
            await state.follow(store.events(), isCurrent: { app.activationGeneration == generation })
        }
        .onChange(of: app.store?.connection) { _, connection in
            if connection == .live { refreshID &+= 1 }
        }
        .onChange(of: shownSessions.map(\.id)) { _, _ in
            doneSelectedID = DonePresentation.nextSelectedID(shownSessions, selectedID: doneSelectedID)
        }
        .onDisappear { presentation &+= 1; restore.clear(); state.close() }
    }

    private func restoreAction(_ session: Session, client: ShepherdClient) -> (String) -> Void {
        let activation = app.activationGeneration
        let shown = presentation
        return { _ in
            Task {
                if await restore.run(.restore(session), commands: .live(client, model: nil),
                    isCurrent: { app.activationGeneration == activation && presentation == shown }) {
                    // The server/event stream owns the live row. Re-read the archived list.
                    refreshID &+= 1
                }
            }
        }
    }

    private func row(_ session: Session) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(verbatim: session.desig).fontWeight(.semibold)
                Text(verbatim: DonePresentation.repoBasename(session.repoPath))
                    .foregroundStyle(.secondary).lineLimit(1)
                if let verdict = DonePresentation.verdict(recap(for: session.id)) {
                    DoneVerdictChip(verdict: verdict)
                }
            }
            TimelineView(.periodic(from: .now, by: 30)) { context in
                Text(verbatim: DonePresentation.finished(session, now: context.date))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Text(verbatim: DonePresentation.snippet(session, recap: recap(for: session.id)))
                .lineLimit(2)
        }
        .padding(.vertical, 4)
        .accessibilityIdentifier("queues-done-row-\(session.id)")
    }
}
