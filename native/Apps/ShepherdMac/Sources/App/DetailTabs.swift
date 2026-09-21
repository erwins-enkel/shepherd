import ShepherdAppCore
import SwiftUI
import ShepherdKit

/// Lifted out of `SessionDetailView` unchanged, so the copy — and therefore the
/// string catalog — stays exactly as Gate 2 left it.
struct PromptTabView: View {
    let session: Session

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
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
        .padding(16)
        .accessibilityIdentifier("detail-tab-prompt")
    }
}
