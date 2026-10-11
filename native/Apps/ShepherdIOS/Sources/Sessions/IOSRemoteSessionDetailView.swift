import SwiftUI
import ShepherdAppCore
import ShepherdKit

/// The detail of a session mirrored from a connected machine (#2768): what the machine reports,
/// the state of its link, and the actions this app does not offer for it, shown disabled with
/// the reason. Read-only — no terminal here yet (its replies would need the coordinator to bridge
/// `/reply`), and nothing reads this server's per-session routes.
struct IOSRemoteSessionDetailView: View {
    let session: Session
    @State private var explaining = false

    private var now: Int { Int(Date.now.timeIntervalSince1970 * 1_000) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                if let line = RemoteSessionCopy.disconnectedLine(session, now: now) {
                    Text(verbatim: line).sessionFont(label: true).foregroundStyle(SessionListStyle.amber)
                        .accessibilityIdentifier("remote-detail-disconnected")
                }
                facts
                Text(verbatim: L.t("remote_detail_task").uppercased())
                    .sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
                Text(verbatim: session.prompt).sessionFont().foregroundStyle(SessionListStyle.ink)
                    .textSelection(.enabled)
                actions
            }
            .padding()
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(SessionListStyle.background)
        .navigationTitle(RemoteSessionCopy.qualifiedDesig(session))
        .navigationBarTitleDisplayMode(.inline)
        .preferredColorScheme(.dark)
        .sheet(isPresented: $explaining) { explanationSheet }
        .accessibilityIdentifier("remote-session-detail")
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: RemoteSessionCopy.qualifiedDesig(session))
                .sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
            Text(verbatim: session.name).sessionFont(weight: .semibold).foregroundStyle(SessionListStyle.bright)
            HStack(spacing: 8) {
                if let host = session.host {
                    let offline = RemoteSessionCopy.isDisconnected(session.connection)
                    Text(verbatim: (offline ? "⚠ " : "") + host.name)
                        .foregroundStyle(offline ? SessionListStyle.amber : SessionListStyle.slate)
                        .accessibilityLabel(L.t("remote_runs_on", host.name))
                }
                Text(verbatim: SessionStatusStyle.label(session.status))
                    .foregroundStyle(SessionStatusStyle.tint(session.status))
            }
            .sessionFont(label: true, weight: .semibold)
        }
    }

    private var facts: some View {
        VStack(alignment: .leading, spacing: 6) {
            fact(L.t("remote_detail_status"), SessionStatusStyle.label(session.status))
            fact(L.t("remote_detail_repo"), (session.repoPath as NSString).lastPathComponent)
            fact(L.t("remote_detail_branch"), session.branch ?? session.baseBranch)
            if let base = session.baseCommit {
                // The commit the machine actually started from (#2763): its origin, not this checkout.
                fact(L.t("remote_detail_base"), "\(session.baseBranch) @ \(base.prefix(7))")
            }
            if session.sandboxDegraded == true {
                fact(L.t("remote_detail_sandbox"), L.t("session_sandbox_degraded_label"))
            }
        }
    }

    private func fact(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(verbatim: label).foregroundStyle(SessionListStyle.muted)
                .frame(minWidth: 90, alignment: .leading)
            Text(verbatim: value).foregroundStyle(SessionListStyle.ink)
        }
        .sessionFont(label: true)
        .accessibilityElement(children: .combine)
    }

    /// Steer, Stop and Archive stay visible but disabled; the info button says why.
    private var actions: some View {
        HStack(spacing: 8) {
            ForEach([L.t("remote_detail_steer"), L.t("remote_detail_stop"), L.t("remote_detail_archive")],
                    id: \.self) { label in
                Button(label) {}
                    .buttonStyle(.bordered)
                    .disabled(true)
            }
            Button { explaining = true } label: {
                Image(systemName: "info.circle").frame(minWidth: 44, minHeight: 44)
            }
            .accessibilityLabel(L.t("remote_detail_actions_aria"))
            .accessibilityIdentifier("remote-detail-actions-why")
        }
        .sessionFont(label: true)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L.t("remote_detail_actions_aria"))
    }

    @ViewBuilder
    private var explanationSheet: some View {
        if let host = session.host, let connection = session.connection {
            let explanation = RemoteSessionCopy.explanation(
                host: host, connection: connection, now: now, terminalHere: false)
            NavigationStack {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(verbatim: explanation.summary)
                        ForEach(explanation.sections) { section in
                            VStack(alignment: .leading, spacing: 3) {
                                Text(verbatim: section.label).sessionFont(weight: .semibold)
                                Text(verbatim: section.text)
                            }
                        }
                    }
                    .sessionFont()
                    .foregroundStyle(SessionListStyle.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                }
                .background(SessionListStyle.background)
                .navigationTitle(explanation.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) {
                    Button(L.t("common_close")) { explaining = false }
                } }
            }
            .presentationDetents([.medium, .large])
            .preferredColorScheme(.dark)
        }
    }
}
