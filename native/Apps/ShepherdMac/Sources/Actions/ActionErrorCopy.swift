import ShepherdKit

/// The two relaunch outcomes that need their own sentence, and nothing else.
///
/// `ShepherdErrorCopy` — S0-owned, and deliberately untouched here — renders `.conflict` and
/// `.upstreamFailure` as the server's own `message`, verbatim, without ever looking at the code
/// that came with it. `SessionCommandState.run` then hands `failureCopy` only that already-mapped
/// `String`. So a closure of the shape `failureCopy: { L.t("native_actions_failed", $0) }` can
/// never tell "a relaunch is already running" from "the linked issue would not re-resolve", and
/// both catalog keys would be dead copy. The bar therefore keeps the thrown error and asks this
/// helper first, exactly as the web does in `ui/src/routes/+page.svelte` — which branches on
/// `ApiError.code`.
///
/// Anything this does not recognise falls through to the generic line wrapped around the server's
/// own words, so an unmapped failure still says something true.
enum ActionErrorCopy {
    /// The server's 409 code for a second relaunch of the same session while the first is still
    /// in flight (`src/server.ts`: `code: "in_progress"`), which the kit carries through
    /// `ShepherdError.conflict(code:message:)`.
    private static let inProgressCode = "in_progress"

    /// The server's 502 body for a same-repo relaunch whose linked issue could not be
    /// re-resolved. The response also carries `code: "issue_unresolved"`, but the kit's
    /// `.upstreamFailure` case holds only the `error` text, so this is matched on the message.
    ///
    /// Deliberately a graceful match: if the server ever rewords it, the operator gets the
    /// generic line wrapped around that new wording rather than a wrong sentence. Carrying the
    /// 502's `code` through the kit would make it exact, but that is a change to
    /// `ShepherdClient+Actions.swift`'s pinned status-to-error mapping and its tests, which is
    /// not this task's to make.
    private static let issueUnresolvedMessage = "could not re-resolve linked issue"

    /// - Parameters:
    ///   - error: the error the relaunch call threw, when the caller kept it; `nil` when it did
    ///     not, which reads the same as an unrecognised failure.
    ///   - fallback: the line `ShepherdErrorCopy` already produced for that error.
    static func relaunchFailure(_ error: (any Error)?, fallback: String) -> String {
        guard let shepherd = error as? ShepherdError else {
            return L.t("native_actions_failed", fallback)
        }
        switch shepherd {
        case .conflict(let code, _) where code == inProgressCode:
            return L.t("relaunch_in_progress")
        case .upstreamFailure(let message) where message == issueUnresolvedMessage:
            return L.t("relaunch_issue_unresolved")
        default:
            return L.t("native_actions_failed", fallback)
        }
    }
}
