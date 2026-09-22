import ShepherdAppCore
import Foundation
import Observation
import ShepherdKit
import SwiftUI

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
        .accessibilityElement(children: .contain)
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
