import SwiftUI
import ShepherdKit
import ShepherdAppCore

struct IOSEpicGroupHeader: View {
    let group: IOSMergedSessionPresentation.EpicGroup
    let summary: EpicSummary?
    let collapsed: Bool
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: 6) {
                Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                if let summary {
                    Text(verbatim: group.repoName).lineLimit(1)
                    Text(verbatim: summary.parentTitle).lineLimit(1).truncationMode(.tail)
                }
                Text(verbatim: "#\(group.parentNumber)").fixedSize()
                Spacer(minLength: 0)
                Text(verbatim: summary.map { L.t("epic_badge", String($0.merged), String($0.total)) }
                    ?? L.t("upnext_pill_epic").uppercased())
                    .monospacedDigit().fixedSize()
                    .padding(.horizontal, 6).padding(.vertical, 3)
                    .overlay { RoundedRectangle(cornerRadius: 2).stroke(SessionListStyle.amber, lineWidth: 1) }
            }
            .frame(minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .sessionFont(label: true, weight: .medium)
        .foregroundStyle(SessionListStyle.amber)
        .accessibilityAddTraits(.isHeader)
        .accessibilityLabel(Text(verbatim: L.t(collapsed ? "epic_group_expand_aria" : "epic_group_collapse_aria", String(group.parentNumber))))
        .accessibilityValue(Text(verbatim: [group.repoName, summary?.parentTitle, summary.map { L.t("epic_badge", String($0.merged), String($0.total)) }].compactMap { $0 }.joined(separator: ", ")))
        .accessibilityIdentifier("herd-epic-\(group.parentNumber)")
        .listRowInsets(EdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 10))
        .listRowBackground(SessionListStyle.background).listRowSeparator(.hidden)
    }
}
