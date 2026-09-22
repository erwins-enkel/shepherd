import ShepherdAppCore
import Foundation
import Observation
import ShepherdKit
import SwiftUI

/// The composition seam preserves the existing action bar. Install after S4, once per scene.
/// The integration lane already owns the call to ComposeStream.install; no shared view changes.
struct ComposeSessionActions: View {
    let session: Session
    let store: SessionStore
    let app: AppModel
    @State private var action: ComposeActions.Action?

    var body: some View {
        HStack {
            Menu(L.t("native_actions_bar_label")) {
                Button(L.t("cardmenu_start_variant")) { action = .variant }
                Button(L.t("cardmenu_replace_with")) { action = .replace }
                Button(L.t("recommend_title")) { action = .recommend }
                Divider()
                Button(L.t("cardmenu_decommission")) { action = .close }
                Divider()
                Button(L.t("steerbar_edit")) { action = .steers }
            }
            .disabled(session.status.known == .archived)
            .accessibilityIdentifier("compose.session-actions")
            Spacer()
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .sheet(item: $action) { mode in
            ComposeActionSheet(mode: mode, session: session, store: store, app: app,
                               activation: app.activationGeneration)
        }
    }
}
