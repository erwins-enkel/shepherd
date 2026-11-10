import SwiftUI
import ShepherdAppCore
import ShepherdKit

/// Chat and machine-reported facts for a mirrored session. Session requests go through
/// the coordinator's forwarded routes; no local terminal is attached.
struct IOSRemoteSessionDetailView: View {
    let session: Session
    @State private var explaining = false
    @State private var tab: IOSSessionDetailTab = .chat
    @State private var chat = IOSChatModel()
    @Environment(AppModel.self) private var app

    private var now: Int { Int(Date.now.timeIntervalSince1970 * 1_000) }

    var body: some View {
        VStack(spacing: 0) {
            header.padding(.horizontal).padding(.top, 8)
            if let line = RemoteSessionCopy.disconnectedLine(session, now: now) {
                Text(verbatim: line).sessionFont(label: true).foregroundStyle(SessionListStyle.amber)
                    .padding(8).accessibilityIdentifier("remote-detail-disconnected")
            }
            Picker(L.t("remote_detail_status"), selection: $tab) {
                Text(L.t("viewport_chat_tab")).tag(IOSSessionDetailTab.chat)
                Text(L.t("native_ios_detail_info")).tag(IOSSessionDetailTab.info)
            }
            .pickerStyle(.segmented).padding()
            if tab == .chat {
                IOSChatView(session: session, model: chat, allowsInput: app.allowsTerminalInput)
            } else { information }
        }
        .background(SessionListStyle.background)
        .navigationTitle(RemoteSessionCopy.qualifiedDesig(session))
        .navigationBarTitleDisplayMode(.inline)
        .preferredColorScheme(.dark)
        .sheet(isPresented: $explaining) { explanationSheet }
        .onDisappear { chat.stopDictation(); chat.attachments?.teardown(); chat.attachments = nil }
        .accessibilityIdentifier("remote-session-detail")
    }

    private var information: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
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

    /// Stop and Archive stay visible but disabled; the info button says why.
    private var actions: some View {
        HStack(spacing: 8) {
            ForEach([L.t("remote_detail_stop"), L.t("remote_detail_archive")],
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
