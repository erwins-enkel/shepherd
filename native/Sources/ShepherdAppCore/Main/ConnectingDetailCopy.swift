import Foundation
import ShepherdKit

/// One label/value line of the detail a slow connect shows.
public struct ConnectingDetailRow: Hashable, Sendable {
    public let label: String
    public let value: String
}

/// What a "connecting" surface adds once it has waited longer than
/// `threshold`. Shepherd's operators are technical: they would rather see where
/// a connect is stuck than watch a spinner. What the platform reports — URLs,
/// HTTP statuses, close codes, URLErrors — stays verbatim; only the words
/// around it are copy.
public enum ConnectingDetailCopy {
    /// How long a connect may take before it explains itself.
    public static let threshold: TimeInterval = 1

    /// A `.connecting` terminal: which socket, which try, and why the last one died.
    public static func terminalRows(_ attempt: PTYConnection.Attempt?, elapsed: TimeInterval) -> [ConnectingDetailRow] {
        var rows: [ConnectingDetailRow] = []
        if let attempt {
            rows.append(.init(label: L.t("native_connect_detail_endpoint"), value: attempt.endpoint))
            rows.append(.init(label: L.t("native_connect_detail_step"), value: step(attempt)))
        }
        rows.append(.init(label: L.t("native_connect_detail_elapsed"), value: self.elapsed(elapsed)))
        if let drop = attempt?.lastDrop {
            rows.append(.init(label: L.t("native_connect_detail_last_failure"), value: describe(drop)))
        }
        if let attempt, attempt.fastFails > 0 {
            rows.append(.init(label: L.t("native_connect_detail_fast_fails"),
                value: L.t("native_connect_fast_fails_value", String(attempt.fastFails),
                           String(PTYConnection.maxFastFails))))
        }
        return rows
    }

    /// A `.connecting` store: which server, what it is waiting on, and why the last try failed.
    public static func serverRows(server: String?, detail: ConnectingDetail?, elapsed: TimeInterval,
                                  now: Date) -> [ConnectingDetailRow] {
        var rows: [ConnectingDetailRow] = []
        if let server { rows.append(.init(label: L.t("native_connect_detail_server"), value: server)) }
        if let detail { rows.append(.init(label: L.t("native_connect_detail_step"), value: step(detail, now: now))) }
        rows.append(.init(label: L.t("native_connect_detail_elapsed"), value: self.elapsed(elapsed)))
        if let failure = detail?.lastFailure {
            rows.append(.init(label: L.t("native_connect_detail_last_failure"), value: failure))
        }
        return rows
    }

    /// Whole seconds, counting up: "4 s".
    public static func elapsed(_ seconds: TimeInterval) -> String {
        L.t("newtask_spawn_seconds", String(Int(max(0, seconds))))
    }

    /// A measured span: "120 ms" below a second, "1.2 s" above.
    public static func duration(_ seconds: TimeInterval) -> String {
        if seconds < 1 { return "\(Int((max(0, seconds) * 1000).rounded())) ms" }
        return L.t("newtask_spawn_seconds", seconds.formatted(.number.precision(.fractionLength(0...1))))
    }

    static func step(_ attempt: PTYConnection.Attempt) -> String {
        switch attempt.stage {
        case .handshake: L.t("native_connect_step_handshake", String(attempt.number))
        case .waiting(let delay): L.t("native_connect_step_retry", duration(seconds(delay)))
        }
    }

    static func step(_ detail: ConnectingDetail, now: Date) -> String {
        switch detail.step {
        case .snapshot:
            return L.t("native_connect_step_snapshot", String(detail.attempt))
        case .events:
            if let retryAt = detail.retryAt, retryAt > now {
                return L.t("native_connect_step_events_retry", String(detail.attempt),
                           elapsed(retryAt.timeIntervalSince(now).rounded(.up)))
            }
            return L.t("native_connect_step_events", String(detail.attempt))
        }
    }

    /// The refused upgrade's status, the close code — or the transport error
    /// when no close frame came — and how long the socket lived.
    static func describe(_ drop: PTYConnection.Drop) -> String {
        var parts: [String] = []
        if let status = drop.httpStatus { parts.append("HTTP \(status)") }
        if drop.closeCode == 0 {
            parts.append(L.t("native_connect_drop_no_close"))
            if let error = drop.error { parts.append(error) }
        } else {
            parts.append(L.t("native_connect_drop_close", String(drop.closeCode)))
        }
        parts.append(L.t("native_connect_drop_lived", duration(seconds(drop.lived))))
        return parts.joined(separator: " · ")
    }

    static func seconds(_ duration: Duration) -> TimeInterval {
        let (seconds, attoseconds) = duration.components
        return TimeInterval(seconds) + TimeInterval(attoseconds) / 1e18
    }
}
