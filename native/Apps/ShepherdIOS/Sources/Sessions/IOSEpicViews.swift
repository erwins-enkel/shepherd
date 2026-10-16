import SwiftUI
import ShepherdAppCore
import ShepherdKit

/// One segment per child: blue merged, amber in flight, line colour otherwise.
struct IOSEpicMeter: View {
    let tones: [EpicMeterTone]
    var height: CGFloat = 2
    var spacing: CGFloat = 1

    var body: some View {
        HStack(spacing: spacing) {
            ForEach(Array(tones.enumerated()), id: \.offset) { _, tone in
                RoundedRectangle(cornerRadius: 1).fill(Self.color(tone))
                    .frame(maxWidth: .infinity).frame(height: height)
            }
        }
        .accessibilityHidden(true)
    }

    static func color(_ tone: EpicMeterTone) -> Color {
        switch tone {
        case .merged: SessionListStyle.blue
        case .inFlight: SessionListStyle.amber
        case .rest: SessionListStyle.brightLine
        }
    }
}

enum IOSEpicDotTone { case ready, active, waiting, merged }

/// The flow's state dot: they differ in fill as well as hue, and always sit next to a label.
struct IOSEpicStateDot: View {
    let tone: IOSEpicDotTone

    var body: some View {
        Group {
            switch tone {
            case .ready: Circle().fill(SessionListStyle.green)
            case .active: Circle().fill(SessionListStyle.amber)
            case .merged: Circle().fill(SessionListStyle.slate)
            case .waiting: Circle().stroke(SessionListStyle.muted, lineWidth: 1.5)
            }
        }
        .frame(width: 8, height: 8)
        .accessibilityHidden(true)
    }

    static func tone(_ child: EpicChild) -> IOSEpicDotTone {
        child.isMerged ? .merged : child.isInFlight ? .active : child.isReady ? .ready : .waiting
    }
}

/// Neutral role chip ("führt", "pausiert"): it says who owns the run, not how it is going.
struct IOSEpicRunChip: View {
    let text: String

    var body: some View {
        Text(verbatim: text.uppercased()).tracking(0.8)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .foregroundStyle(SessionListStyle.muted)
            .overlay { RoundedRectangle(cornerRadius: 2).stroke(SessionListStyle.brightLine, lineWidth: 1) }
    }
}

/// The web's epic cue chips; the glyph keeps two same-hue chips apart.
struct IOSEpicCueChips: View {
    let cues: IOSEpicCues

    var body: some View {
        HStack(spacing: 4) {
            chip("✕", cues.ciFailed, SessionListStyle.red, "epic_group_cue_ci_failed")
            chip("✓", cues.ready, SessionListStyle.green, "epic_group_cue_ready")
            chip("!", cues.needsRework, SessionListStyle.amber, "epic_group_cue_changes_requested")
            chip("!", cues.mergeBlocked, SessionListStyle.amber, "epic_group_cue_merge_blocked")
            chip("!", cues.blocked, SessionListStyle.red, "epic_group_cue_blocked")
        }
        .fixedSize()
    }

    @ViewBuilder
    private func chip(_ glyph: String, _ count: Int, _ tint: Color, _ key: StaticString) -> some View {
        if count > 0 {
            Text(verbatim: "\(glyph) \(count)").monospacedDigit()
                .foregroundStyle(tint)
                .padding(.horizontal, 5).padding(.vertical, 1)
                .overlay { RoundedRectangle(cornerRadius: 2).stroke(tint, lineWidth: 1) }
                .accessibilityLabel(Text(verbatim: L.t(key, String(count))))
        }
    }
}

/// A list row background; for an epic member it carries the hairline rail under the header's
/// chevron, run 3 pt past the row so it bridges the list's 6 pt row spacing.
struct IOSEpicRailBackground: View {
    var rail = true

    var body: some View {
        SessionListStyle.background.overlay(alignment: .leading) {
            if rail {
                Rectangle().fill(SessionListStyle.epicRail).frame(width: 1)
                    .padding(.vertical, -3).padding(.leading, 17)
            }
        }
    }
}
