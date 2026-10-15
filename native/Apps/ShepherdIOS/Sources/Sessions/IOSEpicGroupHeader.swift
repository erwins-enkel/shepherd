import SwiftUI
import ShepherdKit
import ShepherdAppCore

/// The blue epic group header: repo · EPIC badge, title · #parent, then run, clock, stage and
/// cues. Blue is the epic hue (the web's EpicGroupHeader); amber stays for work in flight.
struct IOSEpicGroupHeader: View {
    let group: IOSMergedSessionPresentation.EpicGroup
    let summary: EpicSummary?
    var digest: EpicDigest? = nil
    let collapsed: Bool
    var now = 0
    let toggle: () -> Void
    /// Opens the epic sheet; nil while the full epic is unknown, and the badge is then no button.
    var open: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Button(action: toggle) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                            .foregroundStyle(SessionListStyle.blue).frame(width: 12)
                        Text(verbatim: group.repoName).foregroundStyle(SessionListStyle.muted).lineLimit(1)
                    }
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        if let title {
                            Text(verbatim: title).sessionFont(weight: .semibold)
                                .foregroundStyle(SessionListStyle.bright).lineLimit(1).truncationMode(.tail)
                        }
                        Text(verbatim: "#\(group.parentNumber)").foregroundStyle(SessionListStyle.blue).fixedSize()
                    }
                    .padding(.leading, 20)
                    if digest != nil || !group.cues.isEmpty {
                        statusLine.padding(.leading, 20)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(.isHeader)
            .accessibilityLabel(Text(verbatim: L.t(collapsed ? "epic_group_expand_aria" : "epic_group_collapse_aria",
                String(group.parentNumber))))
            .accessibilityValue(Text(verbatim: accessibilityValue))
            .accessibilityIdentifier("herd-epic-\(group.parentNumber)")
            badge
        }
        .sessionFont(label: true, weight: .medium)
        .padding(.top, 10).padding(.bottom, 6)
        .overlay(alignment: .top) { Rectangle().fill(SessionListStyle.epicRail).frame(height: 1) }
        .listRowInsets(EdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 10))
        .listRowBackground(SessionListStyle.background).listRowSeparator(.hidden)
    }

    private var title: String? {
        (digest?.epic.parentTitle ?? summary?.parentTitle).map(EpicText.displayTitle)
    }

    private var counts: (merged: Int, total: Int)? {
        if let digest { return (merged: digest.merged, total: digest.total) }
        return summary.map { (merged: $0.merged, total: $0.total) }
    }

    private var badgeText: String {
        counts.map { L.t("epic_badge", String($0.merged), String($0.total)) } ?? L.t("upnext_pill_epic").uppercased()
    }

    private var tones: [EpicMeterTone] {
        digest?.meter ?? counts.map { EpicMeter.tones(merged: $0.merged, total: $0.total) } ?? []
    }

    @ViewBuilder private var badge: some View {
        let label = Text(verbatim: badgeText).monospacedDigit().fixedSize()
            .padding(.bottom, 5)
            .overlay(alignment: .bottom) { IOSEpicMeter(tones: tones) }
            .padding(.horizontal, 7).padding(.vertical, 4)
            .foregroundStyle(SessionListStyle.blue)
            .overlay { RoundedRectangle(cornerRadius: 2).stroke(SessionListStyle.blue, lineWidth: 1) }
        if let open, let counts {
            Button(action: open) { label.frame(minHeight: 44).contentShape(Rectangle()) }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(verbatim: L.t("native_ios_epic_open_aria",
                    String(group.parentNumber), String(counts.merged), String(counts.total))))
                .accessibilityIdentifier("herd-epic-open-\(group.parentNumber)")
        } else {
            label.frame(minHeight: 44).accessibilityHidden(true)
        }
    }

    private var statusLine: some View {
        HStack(spacing: 8) {
            if let chip = digest.flatMap({ IOSEpicCopy.runChip($0.epic) }) { IOSEpicRunChip(text: chip) }
            if let clock = digest.flatMap({ IOSEpicCopy.clock($0.epic, now: now) }) { Text(verbatim: clock) }
            if let stage = digest.flatMap(IOSEpicCopy.stage) { Text(verbatim: stage) }
            Spacer(minLength: 0)
            IOSEpicCueChips(cues: group.cues)
        }
        .foregroundStyle(SessionListStyle.muted)
        .lineLimit(1)
    }

    /// The complete announcement also carries cues while the group is collapsed.
    var accessibilityValue: String {
        let counts: [(Int, StaticString)] = [
            (group.cues.ciFailed, "epic_group_cue_ci_failed"),
            (group.cues.needsRework, "epic_group_cue_changes_requested"),
            (group.cues.mergeBlocked, "epic_group_cue_merge_blocked"),
            (group.cues.ready, "epic_group_cue_ready"),
            (group.cues.blocked, "epic_group_cue_blocked")
        ]
        let cues = counts.compactMap { count, key in count > 0 ? L.t(key, String(count)) : nil }
        let details = [group.repoName, digest?.epic.parentTitle ?? summary?.parentTitle, badgeText,
            digest.flatMap { IOSEpicCopy.runChip($0.epic) },
            digest.flatMap { IOSEpicCopy.clock($0.epic, now: now) }, digest.flatMap(IOSEpicCopy.stage)]
            .compactMap { $0 }
        return (details + cues).joined(separator: ", ")
    }
}
