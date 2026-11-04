import ShepherdAppCore
import SwiftUI

/// The card's heavy-check slot line (#3181), matching the web card's PulseLine: ▤ holding with its
/// age, command and memory; ◔ waiting with its place in line and what happens next.
struct HeavySlotLine: View {
    let entry: HeavySlotEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(verbatim: holding ? "▤" : "◔").foregroundStyle(hue)
                Text(verbatim: L.t(holding ? "pulse_state_slot_running" : "pulse_state_slot_waiting").uppercased())
                    .fontWeight(.semibold)
                    .tracking(0.8)
                    .foregroundStyle(ShepherdPalette.inkBright)
                Spacer(minLength: 4)
                metric
            }
            if let detail {
                Text(verbatim: detail).foregroundStyle(ShepherdPalette.muted).lineLimit(1).truncationMode(.middle)
            }
        }
        .font(.caption.monospacedDigit())
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(hue.opacity(0.07), in: RoundedRectangle(cornerRadius: 2))
        .overlay { RoundedRectangle(cornerRadius: 2).stroke(hue.opacity(0.4), lineWidth: 1) }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("heavy-slot-line")
    }

    private var holding: Bool {
        if case .holding = entry { return true }
        return false
    }

    /// Holding is work in progress (amber); waiting keeps the line neutral, as on the web.
    private var hue: Color { holding ? ShepherdPalette.amber : ShepherdPalette.muted }

    @ViewBuilder private var metric: some View {
        switch entry {
        case .holding(_, let startedAt, _):
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let seconds = max(0, Int(context.date.timeIntervalSince1970) - startedAt / 1_000)
                Text(verbatim: "\(seconds / 60):\(String(format: "%02d", seconds % 60))")
                    .foregroundStyle(ShepherdPalette.ink)
            }
        case .waiting(let position, _):
            Text(verbatim: L.t("pulse_slot_place", String(position))).foregroundStyle(ShepherdPalette.ink)
        }
    }

    private var detail: String? {
        switch entry {
        case .holding(let command, _, let rssBytes):
            let gib = rssBytes.map {
                L.t("pulse_slot_gib", (Double($0) / 1_073_741_824).formatted(.number.precision(.fractionLength(1))))
            }
            return [command, gib].compactMap { $0 }.joined(separator: " · ")
        case .waiting(let position, let pressure):
            if pressure { return L.t("pulse_slot_note_pressure") }
            return L.t(position == 1 ? "pulse_slot_note_next" : "pulse_slot_note_informed")
        }
    }
}
