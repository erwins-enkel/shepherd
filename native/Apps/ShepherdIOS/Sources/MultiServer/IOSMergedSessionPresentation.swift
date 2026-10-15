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
        /// The server's own instance ID (`GET /api/instance`); `nil` until it answers.
        var instanceID: String? = nil
        /// Sessions this server mirrors from its connected machines (#2768).
        var remote: [Session] = []
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
    /// One chip per repo NAME: the same repo checked out on several servers lives under
    /// different paths, and the operator still means one repo.
    struct Chip: Identifiable {
        let name: String
        let paths: Set<String>
        let count: Int
        var id: String { name }
    }
    struct Tallies { var active = 0; var idle = 0; var blocked = 0; var total = 0 }
    struct Group: Identifiable {
        let stage: HerdStage
        let rows: [Row]
        let heading: String?
        var id: HerdStage { stage }
    }
    /// One connected machine's mirrored sessions, after the lifecycle groups (All lens).
    struct MachineGroup: Identifiable {
        let host: SessionHost
        let connection: SessionConnection
        let rows: [Row]
        /// The connected server these sessions come through (`über <Server>` in the header).
        var via: ServerProfile { rows[0].profile }
        var id: String { host.instanceId }
    }
    /// One machine a connected server mirrors, as the server list shows it under that server.
    struct MirroredMachine: Identifiable, Equatable {
        let host: SessionHost
        let connection: SessionConnection
        /// The machine is itself a connected server, so its own connection shows its sessions
        /// and this server's copy is hidden (`Ownership`).
        let direct: Bool
        var id: String { host.instanceId }
    }
    struct EpicGroup: Identifiable {
        let id: String
        let profile: ServerProfile
        let repoPath: String
        let parentNumber: Int
        /// Each member’s lifecycle stage, used for cues and reloads.
        var stages: [String: HerdStage] = [:]
        var rows: [Row]
        var repoName: String { (repoPath as NSString).lastPathComponent }
    }
    struct Snapshot {
        let epicGroups: [EpicGroup]
        let groups: [Group]
        let machines: [MachineGroup]
        let finished: [Row]
        let owed: [OwedRow]
        let chips: [Chip]
        let repos: Set<String>
        let tallies: Tallies
    }
    static func serverHint(_ profile: ServerProfile, connectedCount: Int) -> String? {
        connectedCount > 1 ? profile.name : nil
    }
    /// Which connection shows each session (#2768). Sessions merge by `(instance ID, session ID)`:
    /// a server's own session is shown by the first connection that lists it, and a mirrored copy
    /// only while no connection lists that session as its own — so the owner's own connection is
    /// preferred. A server whose instance ID is not known yet keeps the per-server identity the
    /// list always had, and its own sessions still stand in for a mirrored copy with the same
    /// session ID (session IDs are UUIDs), so the moment before `/api/instance` answers shows no
    /// duplicate either.
    struct Ownership {
        private struct Key: Hashable { let instance: String; let session: String }
        private var owners: [Key: UUID] = [:]
        private var unkeyed: Set<String> = []

        init(_ sources: [Source]) {
            for source in sources {
                guard let instance = source.instanceID else {
                    unkeyed.formUnion(source.sessions.map(\.id))
                    continue
                }
                for session in source.sessions where owners[Key(instance: instance, session: session.id)] == nil {
                    owners[Key(instance: instance, session: session.id)] = source.profile.id
                }
            }
        }

        /// Whether `source` is the connection that shows `session`, one of its own.
        func shows(_ session: Session, from source: Source) -> Bool {
            guard let instance = source.instanceID else { return true }
            return owners[Key(instance: instance, session: session.id)] == source.profile.id
        }

        /// Whether a connection lists this mirrored session as its own.
        func ownedDirectly(_ session: Session) -> Bool {
            guard let host = session.host else { return false }
            return owners[Key(instance: host.instanceId, session: session.id)] != nil
                || unkeyed.contains(session.id)
        }
    }

    static func merge(_ sources: [Source], selectedRepos: Set<String>) -> Snapshot {
        let ownership = Ownership(sources)
        var counts: [String: Int] = [:]
        for source in sources {
            for session in source.sessions
            where session.status.known != .archived && ownership.shows(session, from: source) {
                counts[session.repoPath, default: 0] += 1
            }
        }
        let repos = selectedRepos.intersection(counts.keys)
        func shown(_ path: String) -> Bool { repos.isEmpty || repos.contains(path) }
        var tallies = Tallies()
        for source in sources {
            for session in source.rendered
            where session.status.known != .archived && shown(session.repoPath) && ownership.shows(session, from: source) {
                tallies.total += 1
                switch session.status.known {
                case .running: tallies.active += 1
                case .blocked: tallies.blocked += 1
                case .idle: tallies.idle += 1
                default: break
                }
            }
        }
        var epics: [String: EpicGroup] = [:]
        let groups = HerdStage.allCases.compactMap { stage -> Group? in
            var rows = sources.flatMap { source in
                source.groups.filter { $0.stage == stage }.flatMap(\.sessions)
                    .filter { shown($0.repoPath) && ownership.shows($0, from: source) }
                    .map { Row(profile: source.profile, session: $0) }
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
                epics[key]?.stages[row.session.id] = stage
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
        // Mirrored sessions are never narrowed by the repo filter: its chips name checkouts of the
        // connected servers, not of the machines they mirror (the web's machine groups before
        // #3055).
        var machineOrder: [String] = []
        var machineRows: [String: [Row]] = [:]
        var seenMirrored: Set<String> = []
        for source in sources {
            for session in source.remote {
                guard let host = session.host, session.connection != nil, !ownership.ownedDirectly(session),
                      seenMirrored.insert("\(host.instanceId)\u{1}\(session.id)").inserted else { continue }
                if machineRows[host.instanceId] == nil { machineOrder.append(host.instanceId) }
                machineRows[host.instanceId, default: []].append(Row(profile: source.profile, session: session))
            }
        }
        let machines = machineOrder.compactMap { id -> MachineGroup? in
            guard let rows = machineRows[id], let first = rows.first?.session,
                  let host = first.host, let connection = first.connection else { return nil }
            return MachineGroup(host: host, connection: connection, rows: rows)
        }
        let epicGroups = epics.values.sorted {
            let byRepo = $0.repoName.localizedStandardCompare($1.repoName)
            if byRepo != .orderedSame { return byRepo == .orderedAscending }
            if $0.parentNumber != $1.parentNumber { return $0.parentNumber < $1.parentNumber }
            return $0.id < $1.id
        }
        return Snapshot(epicGroups: epicGroups, groups: groups, machines: machines, finished: finished, owed: owed,
            chips: Dictionary(grouping: counts.keys) { ($0 as NSString).lastPathComponent }
                .map { Chip(name: $0.key, paths: Set($0.value), count: $0.value.reduce(0) { $0 + counts[$1]! }) }
                .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending },
            repos: repos, tallies: tallies)
    }

    /// The machines each connected server mirrors, keyed by that server's profile, in the order
    /// its mirrored sessions list them. Only machines with at least one mirrored session show up:
    /// the data is the `host` of those sessions.
    static func mirroredMachines(_ sources: [Source]) -> [UUID: [MirroredMachine]] {
        let ownership = Ownership(sources)
        let instances = Set(sources.compactMap(\.instanceID))
        var result: [UUID: [MirroredMachine]] = [:]
        for source in sources {
            var order: [String] = []
            var byMachine: [String: [Session]] = [:]
            for session in source.remote {
                guard let host = session.host, session.connection != nil,
                      host.instanceId != source.instanceID else { continue }
                if byMachine[host.instanceId] == nil { order.append(host.instanceId) }
                byMachine[host.instanceId, default: []].append(session)
            }
            let machines = order.compactMap { id -> MirroredMachine? in
                guard let sessions = byMachine[id], let host = sessions[0].host,
                      let connection = sessions[0].connection else { return nil }
                return MirroredMachine(host: host, connection: connection,
                    direct: instances.contains(id) || sessions.allSatisfy(ownership.ownedDirectly))
            }
            if !machines.isEmpty { result[source.profile.id] = machines }
        }
        return result
    }

    @MainActor static func snapshot(_ hub: IOSServerHub) -> Snapshot {
        merge(sources(hub), selectedRepos: hub.selectedRepos)
    }

    @MainActor static func sources(_ hub: IOSServerHub) -> [Source] {
        hub.connected.compactMap { app -> Source? in
            guard let profile = app.activeProfile, let sidebar = app.extension(SidebarModel.self) else { return nil }
            let sessions = app.store?.sessions ?? []
            return Source(profile: profile, groups: sidebar.groups, sessions: sessions,
                rendered: sessions.map(sidebar.rendered), git: app.extension(HerdSignals.self)?.git ?? [:],
                finished: app.extension(QueuesModel.self)?.finishedSessions ?? [],
                owed: app.extension(MergeModel.self)?.snapshot.owed ?? [],
                instanceID: app.extension(IOSInstanceIdentity.self)?.instanceID,
                remote: app.store?.remoteSessions ?? [])
        }
    }
}
