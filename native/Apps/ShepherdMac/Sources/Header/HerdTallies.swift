import SwiftUI

/// Aktiv / Inaktiv / Blockiert / Gesamt. Only three of the five statuses get a tally, so the three
/// deliberately do not add up to the total — a done session counts only in `total`.
struct HerdTalliesView: View {
    let tallies: HerdTallies

    var body: some View {
        HStack(spacing: 10) {
            tally("native_herd_counter_active", tallies.active, .green)
            tally("native_herd_counter_idle", tallies.idle, .secondary)
            tally("native_herd_counter_blocked", tallies.blocked, .orange)
            tally("native_herd_counter_total", tallies.total, .primary)
        }
        .font(.caption2)
        .accessibilityIdentifier("herd-tallies")
    }

    private func tally(_ key: StaticString, _ count: Int, _ tint: Color) -> some View {
        HStack(spacing: 3) {
            Text(verbatim: "\(count)").font(.caption2.weight(.semibold)).foregroundStyle(tint)
            Text(verbatim: L.t(key)).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}
