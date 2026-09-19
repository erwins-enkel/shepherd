import SwiftUI
import ShepherdKit

struct SessionDetailView: View {
    let session: Session?

    var body: some View {
        if let session {
            VStack(alignment: .leading, spacing: 20) {
                HStack(spacing: 8) {
                    Text(verbatim: session.desig).font(.title3.monospaced().weight(.semibold))
                    Text(verbatim: session.name).font(.title3)
                    Spacer()
                    Text(verbatim: L.t("native_detail_status_label"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(verbatim: SessionStatusStyle.label(session.status))
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(SessionStatusStyle.tint(session.status).opacity(0.18), in: Capsule())
                        .foregroundStyle(SessionStatusStyle.tint(session.status))
                }

                GroupBox(L.t("newtask_prompt_label")) {
                    ScrollView {
                        Text(verbatim: session.prompt)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    }
                    .frame(maxHeight: 220)
                }

                GroupBox(L.t("native_detail_placeholder_title")) {
                    Text(verbatim: L.t("native_detail_placeholder_body"))
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                Spacer()
            }
            .padding(24)
            .accessibilityIdentifier("session-detail")
        } else {
            ContentUnavailableView(L.t("native_detail_no_selection"), systemImage: "sidebar.left")
        }
    }
}

#if DEBUG
#Preview("Detail") {
    SessionDetailView(session: PreviewData.session()).frame(width: 720, height: 520)
}

#Preview("No selection") {
    SessionDetailView(session: nil).frame(width: 720, height: 520)
}
#endif
