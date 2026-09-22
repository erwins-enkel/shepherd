import ShepherdKit
import SwiftUI

/// Pure rules for the amend sheet.
public enum AmendSubmission {
    /// `AMENDMENT_MAX_CHARS` in `src/task-amendments.ts`. Enforced here so the counter and the
    /// server agree; the server still re-checks.
    ///
    /// The unit is **UTF-16 code units**, not Swift's grapheme clusters, because that is what
    /// both halves of the existing product count: `src/server.ts` checks `text.length` on the
    /// trimmed text and the web's `AmendTaskDialog.svelte` counts `trimmed.length`, and JS
    /// `.length` is UTF-16. Counting graphemes would wave ~1 500 emoji (3 000 code units) past
    /// this gate with the counter still showing headroom, and the operator would get nothing
    /// back but the generic `amend_failed` line from the server's 400.
    public static let maxCharacters = 2_000

    /// The trimmed length in UTF-16 code units — see `maxCharacters`.
    public static func length(of raw: String) -> Int {
        raw.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count
    }

    public static func validate(_ raw: String) -> Bool {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed.utf16.count <= maxCharacters
    }

    /// The amendment is persisted before it is steered, so a delivery that did not land is still
    /// a recorded amendment — and must not read as a failure.
    public static func note(steered: Bool) -> String {
        steered ? L.t("amend_recorded_and_steered") : L.t("amend_recorded_not_steered")
    }
}
