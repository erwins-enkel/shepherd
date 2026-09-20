import ShepherdKit
import SwiftUI

// Task 7 fills this in: `RenameSubmission` (validation + the branch-kept note) and the real
// sheet body with its text field, `SessionCommandState` gate and `NoticeBar`.
//
// It exists here only so `ActionBarView`'s `.sheet(item:)` — which presents it by name — compiles
// and the action bar's own gates can run. Nothing else references it; the stored properties and
// the `onDone` signature are exactly the ones Task 7's brief specifies, so that task replaces
// this file wholesale rather than editing around a placeholder.
struct RenameSheet: View {
    let session: Session
    let store: SessionStore
    let app: AppModel
    /// Called with the success note once the rename lands; the caller dismisses.
    let onDone: (String) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(verbatim: L.t("viewport_rename_aria")).font(.headline)
            HStack {
                Spacer()
                Button(L.t("common_cancel"), role: .cancel) { dismiss() }
            }
        }
        .padding(20)
        .frame(width: 420)
    }
}
