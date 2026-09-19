import SwiftUI
import ShepherdKit

struct SessionRow: View {
    let session: Session

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(SessionStatusStyle.tint(session.status))
                .frame(width: 8, height: 8)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(verbatim: session.desig)
                        .font(.caption.monospaced().weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(verbatim: session.name).lineLimit(1)
                }
                HStack(spacing: 6) {
                    Text(verbatim: SessionStatusStyle.label(session.status))
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(SessionStatusStyle.tint(session.status))
                    if let provider = SessionStatusStyle.providerLabel(session.agentProvider) {
                        Text(verbatim: provider).font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("session-row-\(session.id)")
    }
}

#if DEBUG
#Preview("Session rows") {
    List {
        SessionRow(session: PreviewData.session(status: SessionStatus(known: .running)))
        SessionRow(session: PreviewData.session(
            id: "s2", desig: "TASK-02", name: "blocked on review",
            status: SessionStatus(known: .blocked), agentProvider: .codex))
        SessionRow(session: PreviewData.session(
            id: "s3", desig: "TASK-03", name: "future status",
            status: SessionStatus(unknown: "quiescing"), agentProvider: nil))
    }
    .frame(width: 320)
}
#endif
