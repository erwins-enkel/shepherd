import ShepherdAppCore
import SwiftUI
import ShepherdKit

struct SessionRow: View {
    let session: Session

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(ShepherdPalette.statusTint(session.status))
                .frame(width: 8, height: 8)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(verbatim: session.desig)
                        .modifier(ShepherdMonoFont(label: true))
                        .foregroundStyle(ShepherdPalette.faint)
                    Text(verbatim: session.name).lineLimit(1)
                        .modifier(ShepherdMonoFont(weight: .bold))
                        .foregroundStyle(ShepherdPalette.inkBright)
                }
                HStack(spacing: 6) {
                    Text(verbatim: SessionStatusStyle.label(session.status))
                        .modifier(ShepherdMonoFont(label: true, weight: .bold))
                        .foregroundStyle(ShepherdPalette.statusTint(session.status))
                    if let provider = SessionStatusStyle.providerLabel(session.agentProvider) {
                        Text(verbatim: provider).modifier(ShepherdMonoFont(label: true))
                           .foregroundStyle(ShepherdPalette.muted)
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
