import Foundation
import ShepherdKit

/// Sessions mirrored from connected machines (#2762, #2768) — what both apps show for one. The
/// web's `ui/src/lib/remote-sessions.ts` and `remoteSessionExplanation`
/// (`ui/src/lib/tooltips/explanations.ts`), so a remote session reads the same everywhere.
public enum RemoteSessionCopy {
    /// True for a session the server marks as mirrored: `host` and `connection` both present.
    public static func isMirrored(_ session: Session) -> Bool {
        session.host != nil && session.connection != nil
    }

    /// "MacBook · TASK-07" for a mirrored session, the bare designation for a local one. Machine
    /// names are unique among the connected machines, so the label names exactly one session.
    public static func qualifiedDesig(_ session: Session) -> String {
        session.host.map { "\($0.name) · \(session.desig)" } ?? session.desig
    }

    /// Proper names of the platforms the server reports; anything else passes through.
    public static func platformName(_ platform: InstancePlatform) -> String {
        switch platform.known {
        case .linux: "Linux"
        case .macos: "macOS"
        case .windows: "Windows"
        case nil: platform.rawValue
        }
    }

    /// Only an explicit `disconnected` is one — a state this client does not know is not.
    public static func isDisconnected(_ connection: SessionConnection?) -> Bool {
        connection?.state.known == .disconnected
    }

    /// The machine header's state word.
    public static func stateLabel(_ connection: SessionConnection) -> String {
        isDisconnected(connection) ? L.t("remote_state_disconnected") : L.t("remote_state_connected")
    }

    /// When the shown data was last current: a clock time today, date and time before.
    public static func lastKnown(since: Int, now: Int, calendar: Calendar = .current) -> String {
        let at = Date(timeIntervalSince1970: Double(since) / 1_000)
        let today = Date(timeIntervalSince1970: Double(now) / 1_000)
        return calendar.isDate(at, inSameDayAs: today)
            ? at.formatted(date: .omitted, time: .shortened)
            : at.formatted(date: .numeric, time: .shortened)
    }

    /// "Disconnected – last known 14:32" under a session whose machine is out of reach: the
    /// status beside it is the last one known, not an end. `nil` while it is connected.
    public static func disconnectedLine(_ session: Session, now: Int) -> String? {
        guard let connection = session.connection, isDisconnected(connection) else { return nil }
        return L.t("remote_disconnected_line", lastKnown(since: connection.since, now: now))
    }

    /// Where the session runs, the state of the link and why its actions are not offered.
    /// `terminalHere` is false where the app has no terminal for it (iOS), whose actions
    /// section says so instead of promising one.
    public static func explanation(
        host: SessionHost, connection: SessionConnection, now: Int, terminalHere: Bool = true
    ) -> RemoteExplanation {
        let machine = host.name
        let link = isDisconnected(connection)
            ? L.t("tooltip_remote_disconnected_body", lastKnown(since: connection.since, now: now), machine)
            : L.t("tooltip_remote_connected_body")
        let actions = terminalHere
            ? L.t("tooltip_remote_actions_body", machine)
            : L.t("native_ios_remote_actions_body", machine)
        return RemoteExplanation(
            title: L.t("remote_runs_on", machine),
            summary: L.t("tooltip_remote_summary", machine, platformName(host.platform)),
            sections: [
                .init(label: L.t("tooltip_remote_connection"), text: link),
                .init(label: L.t("tooltip_remote_actions"), text: actions),
            ])
    }
}

/// A scannable explanation: a descriptive title, a short summary and labelled sections with one
/// idea each — the shape of the web's `TooltipExplanation`.
public struct RemoteExplanation: Equatable, Sendable {
    public struct Section: Equatable, Sendable, Identifiable {
        public let label: String
        public let text: String
        public var id: String { label }
    }

    public let title: String
    public let summary: String
    public let sections: [Section]
}

/// One connected machine's mirrored sessions, shown as its own read-only group after the local
/// lifecycle groups.
public struct HerdMachineGroup: Identifiable, Equatable {
    public let host: SessionHost
    public let connection: SessionConnection
    public let sessions: [Session]
    public var id: String { host.instanceId }

    /// One group per machine, in the order the machines' sessions first appear — the web's
    /// `machineGroups`. A session that is not mirrored is skipped.
    public static func groups(_ remote: [Session]) -> [HerdMachineGroup] {
        var order: [String] = []
        var byMachine: [String: (host: SessionHost, connection: SessionConnection, sessions: [Session])] = [:]
        for session in remote {
            guard let host = session.host, let connection = session.connection else { continue }
            if byMachine[host.instanceId] == nil {
                order.append(host.instanceId)
                byMachine[host.instanceId] = (host, connection, [])
            }
            byMachine[host.instanceId]?.sessions.append(session)
        }
        return order.compactMap { id in
            byMachine[id].map { HerdMachineGroup(host: $0.host, connection: $0.connection, sessions: $0.sessions) }
        }
    }
}
