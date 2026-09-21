import Foundation
import ShepherdKit

public enum BackendFailure: Equatable, Sendable {
    case serverUnavailable, runnerUnavailable, sessionGone, sessionSuperseded, undetermined
}
public enum BackendRecovery {
    public static func canManageLocal(profile: ServerProfile?, endpoint: URL) -> Bool {
        profile?.mode == .local && profile?.baseURL == endpoint
    }
    public static func classify(serverReachable: Bool?, diagnostics: DiagnosticsSnapshot?,
                         closure: PTYConnection.Closure?) -> BackendFailure {
        if closure == .gone { return .sessionGone }
        if closure == .superseded { return .sessionSuperseded }
        if serverReachable == false { return .serverUnavailable }
        if serverReachable == true, let check = diagnostics?.checks.first(where: { $0.id == "herdr" }),
           ["diagnostics_hint_herdr_offline", "diagnostics_hint_herdr_missing"].contains(check.hintKey) {
            return .runnerUnavailable
        }
        return .undetermined
    }
    public static func isCompatibleCreateFailure(_ error: any Error) -> Bool {
        switch error as? ShepherdError {
        case .transport: return true
        case .upstreamFailure, .conflict(code: "herdr_restart_required", message: _): return true
        default: return false
        }
    }
    public static func title(_ failure: BackendFailure) -> String {
        switch failure {
        case .serverUnavailable: L.t("native_recovery_server_title")
        case .runnerUnavailable: L.t("native_recovery_runner_title")
        case .sessionGone: L.t("native_terminal_ended_title")
        case .sessionSuperseded: L.t("native_terminal_superseded_title")
        case .undetermined: L.t("native_recovery_unknown_title")
        }
    }
    public static func summary(_ failure: BackendFailure) -> String {
        switch failure {
        case .serverUnavailable: L.t("native_recovery_server_body")
        case .runnerUnavailable: L.t("native_recovery_runner_body")
        case .sessionGone: L.t("native_terminal_ended_body")
        case .sessionSuperseded: L.t("native_terminal_superseded_body")
        case .undetermined: L.t("native_recovery_unknown_body")
        }
    }
}
