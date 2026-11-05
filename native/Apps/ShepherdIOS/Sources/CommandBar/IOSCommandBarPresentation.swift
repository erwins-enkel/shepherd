import Foundation
import ShepherdAppCore
import ShepherdKit

/// Value-only quick-switcher ranking. No navigation, network calls, or mutable app state.
enum IOSCommandBarPresentation {
    enum Kind: Int { case sessions, repos, lenses, commands }
    enum Command: Equatable { case newTask, nextNeedsYou(IOSSessionIdentity), servers }
    enum Action: Equatable {
        case session(IOSSessionIdentity), repo(Set<String>), lens(HerdLens), command(Command)
    }
    struct Row: Identifiable {
        let action: Action
        let title: String
        var subtitle = ""
        var designation = ""
        var positions: [Int] = []
        var repoPositions: [Int] = []
        var designationPositions: [Int] = []
        var glyph: String? = nil
        var symbol = "terminal"
        var rank = 0
        var index = 0
        var id: Int { index }
    }
    struct Group: Identifiable {
        let kind: Kind
        let title: String
        var rows: [Row]
        var id: Int { kind.rawValue }
    }
    struct SessionFacts {
        let status: String
        let needsYou: Bool
    }
    struct Availability {
        var newTask = false
        var servers = true
        var selected: IOSSessionIdentity? = nil
    }

    static func sessions(_ snapshot: IOSMergedSessionPresentation.Snapshot) -> [IOSMergedSessionPresentation.Row] {
        var seen: Set<IOSSessionIdentity> = []
        return (snapshot.groups.flatMap(\.rows) + snapshot.epicGroups.flatMap(\.rows))
            .filter { seen.insert($0.id).inserted }
    }

    static func nextNeedsYou(_ snapshot: IOSMergedSessionPresentation.Snapshot,
                             facts: [IOSSessionIdentity: SessionFacts], selected: IOSSessionIdentity?) -> IOSSessionIdentity? {
        orderedSessions(snapshot, facts: facts).first { $0.id != selected && facts[$0.id]?.needsYou == true }?.id
    }

    private static func orderedSessions(_ snapshot: IOSMergedSessionPresentation.Snapshot,
                                        facts: [IOSSessionIdentity: SessionFacts]) -> [IOSMergedSessionPresentation.Row] {
        sessions(snapshot).enumerated().sorted {
            let a = facts[$0.element.id]?.needsYou == true, b = facts[$1.element.id]?.needsYou == true
            if a != b { return a }
            if $0.element.session.updatedAt != $1.element.session.updatedAt {
                return $0.element.session.updatedAt > $1.element.session.updatedAt
            }
            return $0.offset < $1.offset
        }.map(\.element)
    }

    static func groups(query: String, snapshot: IOSMergedSessionPresentation.Snapshot,
                       facts: [IOSSessionIdentity: SessionFacts], lenses: [HerdLens] = HerdLens.allCases,
                       availability: Availability = .init()) -> [Group] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        var sessionRows: [Row] = []
        for row in orderedSessions(snapshot, facts: facts) {
            let s = row.session, repo = (row.session.repoPath as NSString).lastPathComponent
            let title = s.name.isEmpty ? s.desig : s.name
            let fields = [(title, 0), (s.desig, 100), (repo, 100)]
            let matches = fields.enumerated().compactMap { index, field -> (Int, Int, [Int])? in
                guard let result = IOSFuzzy.fuzzyScore(q, field.0) else { return nil }
                return (index, result.score - field.1, result.positions)
            }
            let best = matches.max { $0.1 < $1.1 }
            guard best != nil || (!q.isEmpty && s.prompt.lowercased().contains(q)) else { continue }
            sessionRows.append(Row(action: .session(row.id), title: title,
                subtitle: repo + " · " + (facts[row.id]?.status ?? SessionStatusStyle.label(s.status)),
                designation: s.desig == title ? "" : s.desig,
                positions: best?.0 == 0 ? best!.2 : [], repoPositions: best?.0 == 2 ? best!.2 : [],
                designationPositions: best?.0 == 1 ? best!.2 : [], rank: best?.1 ?? 500))
        }
        let repoRows = snapshot.chips.compactMap { chip -> Row? in
            guard let result = IOSFuzzy.fuzzyScore(q, chip.name) else { return nil }
            return Row(action: .repo(chip.paths), title: chip.name, positions: result.positions,
                symbol: "folder", rank: result.score)
        }
        let lensRows = lenses.compactMap { lens -> Row? in
            let label = L.t(lens.labelKey)
            guard let result = IOSFuzzy.fuzzyScore(q, label) else { return nil }
            return Row(action: .lens(lens), title: label, positions: result.positions, glyph: lens.glyph, rank: result.score)
        }
        var commands: [(Command, String, String, String)] = []
        if availability.newTask {
            commands.append((.newTask, L.t("commandbar_cmd_new_task"), L.t("commandbar_cmd_new_task_kw"), "plus"))
        }
        if let next = nextNeedsYou(snapshot, facts: facts, selected: availability.selected) {
            commands.append((.nextNeedsYou(next), L.t("commandbar_cmd_next_needs_you"), L.t("commandbar_cmd_next_needs_you_kw"), "arrow.right"))
        }
        if availability.servers { commands.append((.servers, L.t("native_toolbar_servers"), "", "server.rack")) }
        let commandRows: [Row] = q.isEmpty ? [] : commands.compactMap { command, label, keywords, symbol in
            let result = IOSFuzzy.fuzzyScore(q, label)
            guard result != nil || keywords.lowercased().contains(q) else { return nil }
            return Row(action: .command(command), title: label, positions: result?.positions ?? [],
                symbol: symbol, rank: result?.score ?? 500)
        }
        var groups = [
            Group(kind: .sessions, title: L.t("commandbar_group_sessions"), rows: sessionRows),
            Group(kind: .repos, title: L.t("commandbar_group_repos"), rows: repoRows),
            Group(kind: .lenses, title: L.t("commandbar_group_lenses"), rows: lensRows),
            Group(kind: .commands, title: L.t("commandbar_group_commands"), rows: commandRows)
        ].filter { !$0.rows.isEmpty }
        for i in groups.indices {
            groups[i].rows = groups[i].rows.enumerated().sorted {
                $0.element.rank == $1.element.rank ? $0.offset < $1.offset : $0.element.rank > $1.element.rank
            }.map(\.element)
        }
        if !q.isEmpty {
            groups.sort {
                let a = $0.rows[0].rank, b = $1.rows[0].rank
                return a == b ? $0.kind.rawValue < $1.kind.rawValue : a > b
            }
        }
        var index = 0
        for i in groups.indices {
            for j in groups[i].rows.indices { groups[i].rows[j].index = index; index += 1 }
        }
        return groups
    }
}
