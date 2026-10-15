import ShepherdAppCore
import ShepherdKit

/// The web's per-group tallies (`cuesFor` in Herd.svelte); a chip shows only when its count is
/// above zero.
struct IOSEpicCues: Equatable {
    var ciFailed = 0
    var needsRework = 0
    var mergeBlocked = 0
    var ready = 0
    var blocked = 0
    var isEmpty: Bool { self == IOSEpicCues() }
}

extension IOSMergedSessionPresentation.EpicGroup {
    var cues: IOSEpicCues {
        var cues = IOSEpicCues()
        for row in rows {
            switch stages[row.session.id] {
            case .ciFailed: cues.ciFailed += 1
            case .needsRework: cues.needsRework += 1
            case .branchProtectionBlocked: cues.mergeBlocked += 1
            case .ready: cues.ready += 1
            default: break
            }
            if row.session.status.known == .blocked { cues.blocked += 1 }
        }
        return cues
    }

    /// Changes whenever a member session appears, leaves or moves (lifecycle stage or status);
    /// the directory re-reads the epic then.
    var fingerprint: String {
        rows.map { "\($0.session.id):\(stages[$0.session.id]?.rawValue ?? "-"):\($0.session.status.rawValue)" }
            .sorted().joined(separator: ",")
    }
}
