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
    /// The complete identity surface opens detail, including before its digest arrives.
    var open: (() -> Void)? = nil
    var control: IOSEpicControl? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 0) {
                Button(action: toggle) {
                    Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                        .foregroundStyle(SessionListStyle.blue).frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }.buttonStyle(.plain)
                    .accessibilityLabel(L.t(collapsed ? "native_ios_epic_expand" : "native_ios_epic_collapse"))
                    .accessibilityIdentifier("herd-epic-toggle-\(group.parentNumber)")
                Button { open?() } label: {
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(spacing: 8) {
                            Text(verbatim: group.repoName).foregroundStyle(SessionListStyle.muted).lineLimit(1)
                            Spacer(minLength: 0)
                            badge
                        }
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            if let title {
                                Text(verbatim: title).sessionFont(weight: .semibold)
                                    .foregroundStyle(SessionListStyle.bright).lineLimit(2)
                            }
                            Text(verbatim: "#\(group.parentNumber)").foregroundStyle(SessionListStyle.blue).fixedSize()
                        }
                        if digest != nil || !group.cues.isEmpty { statusLine }
                    }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityAddTraits(.isHeader)
                    .accessibilityLabel(L.t("native_ios_epic_detail", String(group.parentNumber)))
                    .accessibilityValue(Text(verbatim: accessibilityValue))
                    .accessibilityIdentifier("herd-epic-open-\(group.parentNumber)")
            }
            if let control, control.writable, let digest {
                let actions = IOSEpicPolicy.actions(digest.epic)
                if !actions.isEmpty {
                    SessionWrappingLayout(spacing: 8) {
                        ForEach(Array(actions.enumerated()), id: \.offset) { _, action in
                            Button { Task { await control.perform(action) } } label: {
                                Text(verbatim: IOSEpicControlCopy.action(action))
                                    .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                            }.buttonStyle(.plain).foregroundStyle(SessionListStyle.amber)
                                .disabled(control.busy)
                        }
                        if control.busy { ProgressView().accessibilityLabel(L.t("common_loading")) }
                    }.padding(.leading, 44)
                }
            }
            if let error = control?.error {
                Text(verbatim: error).foregroundStyle(SessionListStyle.red).padding(.leading, 44)
            }
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

    private var badge: some View {
        Text(verbatim: badgeText).monospacedDigit().fixedSize()
            .padding(.bottom, 5)
            .overlay(alignment: .bottom) { IOSEpicMeter(tones: tones) }
            .padding(.horizontal, 7).padding(.vertical, 4)
            .foregroundStyle(SessionListStyle.blue)
            .overlay { RoundedRectangle(cornerRadius: 2).stroke(SessionListStyle.blue, lineWidth: 1) }
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
