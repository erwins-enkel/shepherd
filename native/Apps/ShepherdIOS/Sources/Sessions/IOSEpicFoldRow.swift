import SwiftUI
import ShepherdAppCore
import ShepherdKit

/// "WEITERE SCHRITTE (n)": the epic's children without a session, folded into one row; expanded,
/// they list by stage. A child opens the epic sheet.
struct IOSEpicFoldRow: View {
    let fold: EpicFold
    let parent: Int
    let expanded: Bool
    let toggle: () -> Void
    let open: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Button(action: toggle) {
                HStack(spacing: 8) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right").frame(width: 12)
                    Text(verbatim: L.t("native_ios_epic_more_steps", String(fold.count)).uppercased())
                        .tracking(0.8).lineLimit(1)
                    Spacer(minLength: 6)
                    if let summaryText { Text(verbatim: summaryText).lineLimit(1) }
                }
                .padding(.horizontal, 12)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .overlay { Rectangle().stroke(SessionListStyle.brightLine, style: StrokeStyle(lineWidth: 1, dash: [4, 3])) }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(Text(verbatim: L.t(expanded ? "native_ios_group_expanded" : "native_ios_group_collapsed")))
            .accessibilityIdentifier("epic-fold-\(parent)")
            if expanded {
                ForEach(fold.stages, id: \.index) { stage in
                    Text(verbatim: stageLabel(stage).uppercased()).tracking(0.8)
                        .padding(.top, 8).padding(.bottom, 2)
                        .accessibilityAddTraits(.isHeader)
                    ForEach(stage.items, id: \.child.number) { item in
                        Button(action: open) { itemRow(item) }.buttonStyle(.plain)
                    }
                }
            }
        }
        .sessionFont(label: true)
        .foregroundStyle(SessionListStyle.muted)
    }

    private var summaryText: String? {
        switch fold.summary {
        case .ready(let count): L.t("native_ios_epic_fold_ready", String(count))
        case .waiting(let on): L.t("native_ios_epic_fold_next_after", EpicText.numbers(on))
        case nil: nil
        }
    }

    private func stageLabel(_ stage: EpicFold.Stage) -> String {
        stage.after.isEmpty ? L.t("native_ios_epic_stage_only", String(stage.index))
            : L.t("native_ios_epic_stage_after", String(stage.index), EpicText.numbers(stage.after))
    }

    private func itemRow(_ item: EpicFold.Item) -> some View {
        HStack(spacing: 9) {
            IOSEpicStateDot(tone: IOSEpicStateDot.tone(item.child))
            Text(verbatim: "#\(item.child.number)").foregroundStyle(SessionListStyle.bright)
            Text(verbatim: EpicText.stepTitle(item.child.title, parent: parent))
                .lineLimit(1).truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            if item.unlocks > 0 {
                Text(verbatim: L.t("native_ios_epic_frees", String(item.unlocks))).fixedSize()
            }
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }
}
