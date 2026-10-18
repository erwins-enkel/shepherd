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
    /// Match the live session first, then its issue when an epic still carries an old ID.
    func row(for child: EpicChild) -> IOSMergedSessionPresentation.Row? {
        child.sessionId.flatMap { id in rows.first { $0.session.id == id } }
            ?? rows.first { $0.session.issueNumber == child.number }
    }


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
            if (renderedStatuses[row.session.id] ?? row.session.status).known == .blocked { cues.blocked += 1 }
        }
        return cues
    }

    /// Changes whenever a member session appears, leaves or moves (lifecycle stage or PR);
    /// the directory re-reads the epic then.
    var fingerprint: String {
        rows.map { "\($0.session.id):\(stages[$0.session.id]?.rawValue ?? "-"):\(prNumbers[$0.session.id].map(String.init) ?? "-")" }
            .sorted().joined(separator: ",")
    }
}

/// Membership follows the live list; the opening group keeps detail available after its last session leaves.
struct IOSEpicSelection: Identifiable {
    let id: String
    let fallback: IOSMergedSessionPresentation.EpicGroup?

    init(id: String) { self.id = id; fallback = nil }
    init(group: IOSMergedSessionPresentation.EpicGroup) { id = group.id; fallback = group }

    func resolve(in groups: [IOSMergedSessionPresentation.EpicGroup]) -> IOSMergedSessionPresentation.EpicGroup? {
        groups.first { $0.id == id }
    }
}
