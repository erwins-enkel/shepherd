import Foundation
import ShepherdAppCore
import ShepherdKit

/// Value-only snapshots: identities and all ordering/filtering are independent of SwiftUI.
enum IOSMergedSessionPresentation {
    struct Source {
        let profile: ServerProfile
        let groups: [HerdGroup]
        let sessions: [Session]
        let rendered: [Session]
        let git: [String: GitState]
        let finished: [Session]
        let owed: [PostMergeSteps]
    }
    struct Row: Identifiable {
        let profile: ServerProfile
        let session: Session
        var id: IOSSessionIdentity { .init(profileID: profile.id, sessionID: session.id) }
    }
    struct OwedRow: Identifiable {
        let profile: ServerProfile
        let record: PostMergeSteps
        var id: IOSSessionIdentity { .init(profileID: profile.id, sessionID: record.sessionId) }
    }
    struct Chip: Identifiable {
        let path: String
        let count: Int
        var name: String { (path as NSString).lastPathComponent }
        var id: String { path }
    }
    struct Tallies { var active = 0; var idle = 0; var blocked = 0; var total = 0 }
    struct Group: Identifiable {
        let stage: HerdStage
        let rows: [Row]
        let heading: String?
        var id: HerdStage { stage }
    }
    struct EpicGroup: Identifiable {
        let id: String
        let profile: ServerProfile
        let repoPath: String
        let parentNumber: Int
        var rows: [Row]
        var repoName: String { (repoPath as NSString).lastPathComponent }
    }
    struct Snapshot {
        let epicGroups: [EpicGroup]
        let groups: [Group]
        let finished: [Row]
        let owed: [OwedRow]
        let chips: [Chip]
        let repos: Set<String>
        let tallies: Tallies
    }
    static func serverHint(_ profile: ServerProfile, connectedCount: Int) -> String? {
        connectedCount > 1 ? profile.name : nil
    }
    static func merge(_ sources: [Source], selectedRepos: Set<String>) -> Snapshot {
        var counts: [String: Int] = [:]
        for session in sources.flatMap(\.sessions) where session.status.known != .archived {
            counts[session.repoPath, default: 0] += 1
        }
        let repos = selectedRepos.intersection(counts.keys)
        func shown(_ path: String) -> Bool { repos.isEmpty || repos.contains(path) }
        var tallies = Tallies()
        for session in sources.flatMap(\.rendered) where session.status.known != .archived && shown(session.repoPath) {
            tallies.total += 1
            switch session.status.known {
            case .running: tallies.active += 1
            case .blocked: tallies.blocked += 1
            case .idle: tallies.idle += 1
            default: break
            }
        }
        var epics: [String: EpicGroup] = [:]
        let groups = HerdStage.allCases.compactMap { stage -> Group? in
            var rows = sources.flatMap { source in
                source.groups.filter { $0.stage == stage }.flatMap(\.sessions)
                    .filter { shown($0.repoPath) }.map { Row(profile: source.profile, session: $0) }
            }
            guard !rows.isEmpty else { return nil }
            // Core preserves the server's ORDER BY createdAt. Across servers use that same
            // key, with a stable tie; a single server keeps its exact existing ordering.
            if sources.count > 1 {
                rows = rows.enumerated().sorted {
                    $0.element.session.createdAt == $1.element.session.createdAt ? $0.offset < $1.offset
                        : $0.element.session.createdAt < $1.element.session.createdAt
                }.map(\.element)
            }
            rows = rows.filter { row in
                guard let parent = row.session.epicParent,
                    row.session.issueNumber != parent else { return true }
                let key = "\(row.profile.id):\(row.session.repoPath)#\(parent)"
                if epics[key] == nil {
                    epics[key] = EpicGroup(id: key, profile: row.profile,
                        repoPath: row.session.repoPath, parentNumber: parent, rows: [])
                }
                epics[key]?.rows.append(row)
                return false
            }
            guard !rows.isEmpty else { return nil }
            let names = rows.map { row in
                sources.first { $0.profile.id == row.profile.id }?.git[row.session.id]?.handoffWho
            }.map { $0?.isEmpty == false ? $0 : nil }
            let who = Set(names).count == 1 ? names.first.flatMap { $0 } : nil
            let count = String(rows.count)
            let heading: String?
            if names.allSatisfy({ $0 == nil }), stage == .waitingOnReviewer {
                heading = L.t("herd_waiting_reviewer_group_maintainers", count)
            } else if names.allSatisfy({ $0 == nil }), stage == .waitingOnMerger {
                heading = L.t("herd_waiting_merger_group_maintainers", count)
            } else if let key = stage.headingKey(who: who) {
                heading = who.map { L.t(key, $0, count) } ?? L.t(key, count)
            } else { heading = nil }
            return Group(stage: stage, rows: rows, heading: heading)
        }
        let finished = sources.flatMap { source in
            source.finished.filter { shown($0.repoPath) }.map { Row(profile: source.profile, session: $0) }
        }.enumerated().sorted {
            let a = $0.element.session, b = $1.element.session
            let left = a.archivedAt ?? a.updatedAt, right = b.archivedAt ?? b.updatedAt
            return left == right ? (a.id == b.id ? $0.offset < $1.offset : a.id < b.id) : left > right
        }.map(\.element)
        let owed = sources.flatMap { source in
            MergeRules.owed(source.owed, repos: repos).map { OwedRow(profile: source.profile, record: $0) }
        }.enumerated().sorted {
            let left = $0.element.record.createdAt, right = $1.element.record.createdAt
            return left == right ? $0.offset < $1.offset : left > right
        }.map(\.element)
        let epicGroups = epics.values.sorted {
            let byRepo = $0.repoName.localizedStandardCompare($1.repoName)
            if byRepo != .orderedSame { return byRepo == .orderedAscending }
            if $0.parentNumber != $1.parentNumber { return $0.parentNumber < $1.parentNumber }
            return $0.id < $1.id
        }
        return Snapshot(epicGroups: epicGroups, groups: groups, finished: finished, owed: owed,
            chips: counts.keys.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
                .map { Chip(path: $0, count: counts[$0]!) }, repos: repos, tallies: tallies)
    }

    @MainActor static func snapshot(_ hub: IOSServerHub) -> Snapshot {
        let sources = hub.connected.compactMap { app -> Source? in
            guard let profile = app.activeProfile, let sidebar = app.extension(SidebarModel.self) else { return nil }
            let sessions = app.store?.sessions ?? []
            return Source(profile: profile, groups: sidebar.groups, sessions: sessions,
                rendered: sessions.map(sidebar.rendered), git: app.extension(HerdSignals.self)?.git ?? [:],
                finished: app.extension(QueuesModel.self)?.finishedSessions ?? [],
                owed: app.extension(MergeModel.self)?.snapshot.owed ?? [])
        }
        return merge(sources, selectedRepos: hub.selectedRepos)
    }
}
