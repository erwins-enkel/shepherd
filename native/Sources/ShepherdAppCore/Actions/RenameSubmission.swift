import ShepherdKit
import SwiftUI

/// Pure rules for the rename sheet, pulled out of the view so they are testable without
/// hosting SwiftUI (pattern: `LoginSheetState`, `NewSessionSubmission`).
public enum RenameSubmission {
    /// The server rejects a name that is blank after trimming (`parseRenameName`), so the sheet
    /// refuses to send one rather than round-tripping a 400. A name that trims back to the one
    /// the session already has is a no-op, not a request: the web's `commitRename`
    /// (`ui/src/lib/components/Viewport.svelte:1029`) closes the dialog without calling the
    /// route, and so does this sheet.
    ///
    /// - Parameter current: the session's present name, so "unchanged" can be recognised. Left
    ///   empty by callers that only care about blankness.
    public static func validate(_ raw: String, current: String = "") -> Bool {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed != current.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// What to tell the operator afterwards. A rename whose branch did NOT move is not a
    /// failure, but it is also not what was asked for — an open PR pinned the head branch — and
    /// saying so is the difference between a surprise and an explanation.
    ///
    /// The server answers `branchRenamed: false` for two very different reasons
    /// (`src/server.ts:3359-3362`): a branch that exists but could not be moved, and a session
    /// that has no branch to move at all (non-isolated, or branchless). Only the first is worth
    /// a sentence, so the note is gated on the session actually having a branch — exactly the
    /// web's `if (session.branch && !res.branchRenamed)` at `Viewport.svelte:1036`.
    public static func note(for result: RenameResult) -> String {
        if !result.branchRenamed, result.session.branch != nil {
            return L.t("viewport_rename_branch_kept")
        }
        return L.t("toast_renamed", result.session.name)
    }

    /// The 409 `name_taken` conflict comes back as the server's own word (`src/server.ts:3380`
    /// answers `{ error: "name_taken" }` with no separate `code`, so `ShepherdErrorCopy` hands
    /// the raw string through). Give it the sentence the web shows rather than echoing
    /// "name_taken" at the operator; everything else gets the generic rename failure.
    public static func failureCopy(_ raw: String) -> String {
        raw == "name_taken" ? L.t("viewport_rename_name_taken") : L.t("viewport_rename_failed")
    }
}
