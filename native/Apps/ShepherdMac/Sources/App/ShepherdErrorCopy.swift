import Foundation
import ShepherdKit

/// The single place that turns a ShepherdKit error into operator-facing copy.
///
/// The switch is exhaustive over `ShepherdError` on purpose: when the kit gains a
/// case, this file must stop compiling rather than quietly render a Swift dump in
/// a sheet. Cases the server describes in words (`badRequest`, `conflict`,
/// `unprocessable`, `upstreamFailure`) show that text verbatim — it is already
/// written for a human and is more specific than anything this app could add.
enum ShepherdErrorCopy {
    static func message(_ error: any Error) -> String {
        // The remote-server form's two parse failures.
        if let field = error as? RemoteServerForm.FieldError {
            switch field {
            case .empty: return L.t("native_url_error_empty")
            case .malformed: return L.t("native_url_error_malformed")
            }
        }
        // ServerProfile.validated() throws this bare; ShepherdClient wraps the
        // same value in .insecureProfile. One spelling of the copy for both.
        if let profile = error as? ServerProfileError {
            switch profile {
            case .insecureRemoteURL: return L.t("native_url_error_insecure")
            case .missingHost: return L.t("native_url_error_malformed")
            }
        }
        // ProfileSetup.login rethrows this bare when the minted token cannot be
        // stored: a locked or otherwise refusing Keychain is not a network
        // failure, so it must not read as "cannot reach the server".
        if let keychain = error as? KeychainError {
            switch keychain {
            case .unexpectedStatus: return L.t("native_error_keychain")
            case .malformedItem: return L.t("native_error_keychain")
            }
        }
        guard let shepherd = error as? ShepherdError else {
            // Anything not from the kit — a URLError from the local probe, say.
            return L.t("native_error_offline")
        }
        switch shepherd {
        case .unauthenticated: return L.t("login_error")
        case .forbidden: return L.t("native_error_forbidden")
        case .firstRunPending: return L.t("native_error_first_run")
        case .notFound: return L.t("native_error_not_found")
        case .badRequest(let message): return message
        case .conflict(_, let message): return message
        case .unprocessable(let message): return message
        case .upstreamFailure(let message): return message
        case .contractMismatch: return L.t("native_error_mismatch")
        case .insecureProfile(let reason): return message(reason)
        case .transport: return L.t("native_error_offline")
        // A cancelled request is the app walking away from its own call, so
        // there is nothing to tell the operator: `SessionStore` never records
        // it in `lastError`, and no banner reacts to it. This arm exists only
        // because the switch is exhaustive — a view that cancels a task it
        // started and then insists on showing something gets the neutral
        // "cannot reach the server" line rather than a Swift dump.
        case .cancelled: return L.t("native_error_offline")
        }
    }

    static func isAuthFailure(_ error: any Error) -> Bool {
        guard let shepherd = error as? ShepherdError else { return false }
        switch shepherd {
        case .unauthenticated, .forbidden: return true
        case .firstRunPending, .notFound, .badRequest, .conflict, .unprocessable,
             .upstreamFailure, .contractMismatch, .insecureProfile, .transport, .cancelled:
            return false
        }
    }
}
