import ShepherdAppCore
import ShepherdKit
import SwiftUI

/// The detail of a session mirrored from a connected machine (#2768), in place of the registered
/// tabs: what the machine reports, its live terminal — which this server bridges to the machine
/// (#2764) — and the actions this server cannot run on it, shown disabled with the reason. Nothing
/// here reads this server's per-session routes. The web's `RemoteSessionDetail.svelte`.
struct RemoteSessionDetailView: View {
    let session: Session
    let store: SessionStore
    @Environment(AppModel.self) private var app
    @State private var explaining = false

    private var now: Int { Int(Date.now.timeIntervalSince1970 * 1_000) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            if let line = RemoteSessionCopy.disconnectedLine(session, now: now) {
                Text(verbatim: line)
                    .font(.caption)
                    .foregroundStyle(ShepherdPalette.amber)
                    .accessibilityIdentifier("remote-detail-disconnected")
            }
            facts
            Text(verbatim: L.t("remote_detail_task").uppercased())
                .font(.caption)
                .tracking(2)
                .foregroundStyle(.secondary)
            // The terminal below gets the room; a long task scrolls in place.
            ScrollView {
                Text(verbatim: session.prompt)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 110)
            if let host = session.host, let connection = session.connection {
                actions(host: host, connection: connection)
            }
            terminal
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("remote-session-detail")
    }

    private var header: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: RemoteSessionCopy.qualifiedDesig(session))
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                Text(verbatim: session.name).font(.title3).lineLimit(1)
            }
            Spacer()
            MachineBadge(session: session, now: now)
            Text(verbatim: SessionStatusStyle.label(session.status))
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(SessionStatusStyle.tint(session.status).opacity(0.18), in: Capsule())
                .foregroundStyle(SessionStatusStyle.tint(session.status))
        }
    }

    private var facts: some View {
        Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 4) {
            fact(L.t("remote_detail_status"), SessionStatusStyle.label(session.status))
            fact(L.t("remote_detail_repo"), (session.repoPath as NSString).lastPathComponent,
                help: session.repoPath)
            fact(L.t("remote_detail_branch"), session.branch ?? session.baseBranch)
            if let placement = session.launchMetadata?.placement {
                // Why it runs on that machine (#2776), as the Shepherd that chose it recorded.
                GridRow {
                    Text(verbatim: L.t("remote_detail_placement")).foregroundStyle(.secondary)
                    PlacementReason(placement: placement)
                }
            }
            if let base = session.baseCommit {
                // The commit the machine actually started from (#2763): its origin, not this checkout.
                fact(L.t("remote_detail_base"), "\(session.baseBranch) @ \(base.prefix(7))", help: base)
            }
            if session.sandboxDegraded == true {
                GridRow {
                    Text(verbatim: L.t("remote_detail_sandbox")).foregroundStyle(.secondary)
                    Text(verbatim: L.t("session_sandbox_degraded_label"))
                        .foregroundStyle(ShepherdPalette.warn)
                        .help(L.t("session_sandbox_degraded_title"))
                }
            }
        }
        .font(.callout)
    }

    /// A `GridRow` itself, never wrapped: a modified row would span every column instead.
    private func fact(_ label: String, _ value: String, help: String? = nil) -> some View {
        GridRow {
            Text(verbatim: label).foregroundStyle(.secondary)
            Text(verbatim: value).lineLimit(1).truncationMode(.middle).help(help ?? value)
        }
    }

    /// Steer, Stop and Archive stay visible but disabled: the coordinator has no such route for a
    /// session on another machine, and nothing is ever run here in their place.
    private func actions(host: SessionHost, connection: SessionConnection) -> some View {
        let reason = L.t("tooltip_remote_actions_body", host.name)
        return HStack(spacing: 8) {
            ForEach([L.t("remote_detail_steer"), L.t("remote_detail_stop"), L.t("remote_detail_archive")],
                    id: \.self) { label in
                Button(label) {}
                    .disabled(true)
                    .help(reason)
            }
            Button { explaining = true } label: {
                Label(L.t("tooltip_remote_actions"), systemImage: "info.circle").labelStyle(.iconOnly)
            }
            .buttonStyle(.borderless)
            .help(reason)
            .accessibilityLabel(L.t("remote_detail_actions_aria"))
            .accessibilityIdentifier("remote-detail-actions-why")
            .popover(isPresented: $explaining) {
                RemoteExplanationView(
                    explanation: RemoteSessionCopy.explanation(host: host, connection: connection, now: now))
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L.t("remote_detail_actions_aria"))
        .accessibilityIdentifier("remote-detail-actions")
    }

    /// The same `/pty/:id` as a local session; the server bridges it to the machine. A terminal
    /// that ended because the machine was unreachable reopens once the machine's link is back.
    @ViewBuilder
    private var terminal: some View {
        if let controller = app.extension(TerminalController.self), let host = session.host {
            let model = controller.model(for: session.id)
            TerminalPane(model: model, store: store, sessionID: session.id, app: app,
                activation: app.activationGeneration, machine: host)
                .id(session.id)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .onChange(of: session.connection, initial: true) { _, connection in
                    if let connection { model.machineConnectionChanged(connection) }
                }
        }
    }
}
