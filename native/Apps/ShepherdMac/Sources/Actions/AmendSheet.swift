import ShepherdKit
import SwiftUI

// Task 7 fills this in: `AmendSubmission` (the character cap, validation and the
// recorded/steered notes) and the real sheet body with its editor, steer toggle,
// `SessionCommandState` gate and `NoticeBar`.
//
// It exists here only so `ActionBarView`'s `.sheet(item:)` — which presents it by name — compiles
// and the action bar's own gates can run. Nothing else references it; the stored properties and
// the `onDone` signature are exactly the ones Task 7's brief specifies, so that task replaces
// this file wholesale rather than editing around a placeholder.
struct AmendSheet: View {
    let session: Session
    let store: SessionStore
    let app: AppModel
    let onDone: (String) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(verbatim: L.t("amend_title", session.name)).font(.headline)
            HStack {
                Spacer()
                Button(L.t("common_cancel"), role: .cancel) { dismiss() }
            }
        }
        .padding(20)
        .frame(width: 520)
    }
}
