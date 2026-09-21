import SwiftUI
import ShepherdKit

/// heartbeat.ts: 24 twenty-second cells over the last eight minutes, oldest first.
public enum HerdHeartbeat {
    public struct Cell: Identifiable {
        public let id: Int
        public var level = 0
        public var error = false
        public var newest = false
        public var tint: Color { error ? .red : (level > 0 ? .orange : .secondary) }
        public var label: String {
            if error { return L.t("heartbeat_legend_error_label") }
            return level > 0 ? L.t("heartbeat_legend_active_label") : L.t("heartbeat_legend_idle_label")
        }
    }

    public static func cells(_ activity: SessionActivitySignal?, now: Int) -> [Cell] {
        var cells = (0..<24).map { Cell(id: $0) }
        let errors = Set(activity?.recentErrTs ?? [])
        var newest = 0
        var newestIndex: Int?
        for ts in activity?.recentTs ?? [] {
            guard ts > 0, ts <= now, now - ts < 480_000 else { continue }
            let index = 23 - (now - ts) / 20_000
            cells[index].level = min(4, cells[index].level + 1)
            cells[index].error = cells[index].error || errors.contains(ts)
            if ts > newest { newest = ts; newestIndex = index }
        }
        if let newestIndex { cells[newestIndex].newest = true }
        return cells
    }
}
