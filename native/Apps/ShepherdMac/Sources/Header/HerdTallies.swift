import ShepherdAppCore
import SwiftUI

/// Aktiv / Inaktiv / Blockiert / Gesamt. Only three of the five statuses get a tally, so the three
/// deliberately do not add up to the total — a done session counts only in `total`.
struct HerdTalliesView: View {
    let tallies: HerdTallies

    var body: some View {
        HStack(spacing: 10) {
            tally("native_herd_counter_active", tallies.active, ShepherdPalette.green)
            tally("native_herd_counter_idle", tallies.idle, ShepherdPalette.ink)
            tally("native_herd_counter_blocked", tallies.blocked, ShepherdPalette.amber)
            tally("native_herd_counter_total", tallies.total, ShepherdPalette.inkBright)
        }
        .modifier(ShepherdMonoFont(label: true))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("herd-tallies")
    }

    private func tally(_ key: StaticString, _ count: Int, _ tint: Color) -> some View {
        HStack(spacing: 3) {
            Text(verbatim: "\(count)").modifier(ShepherdMonoFont(label: true, weight: .semibold)).foregroundStyle(tint)
            Text(verbatim: L.t(key)).foregroundStyle(ShepherdPalette.muted)
        }
        .accessibilityElement(children: .combine)
    }
}
