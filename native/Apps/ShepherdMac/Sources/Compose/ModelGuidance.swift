import ShepherdAppCore
import ShepherdKit
import SwiftUI

struct ModelGuidanceView: View {
    let guidance: ModelGuidance

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                badge(guidance.costBadge).accessibilityIdentifier("compose.model.cost")
                badge(guidance.tagBadge).accessibilityIdentifier("compose.model.tag")
            }
            Text(verbatim: guidance.detail)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("compose.model.guidance")
        }
    }

    private func badge(_ text: String) -> some View {
        Text(verbatim: text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(.quaternary, in: Capsule())
    }
}
