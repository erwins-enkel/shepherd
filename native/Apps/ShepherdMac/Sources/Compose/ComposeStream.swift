import ShepherdKit
import SwiftUI

@MainActor
enum ComposeStream {
    private static var capturedActionBar = false
    private static var actionBarBase: (@MainActor (Session, SessionStore, AppModel) -> AnyView)?

    static func resetActionsForTesting() { capturedActionBar = false; actionBarBase = nil }
    static func install(_ app: AppModel) {
        // Integration owns the caller. The existing NewSessionSheet remains the empty-slot fallback.
        NewSessionSlot.content = { app in AnyView(ComposeSheet().environment(app)) }
        // S4's closure takes its live model as an argument, so retain that base once and
        // reassign the composed slot on every installation, without recursively wrapping it.
        if !capturedActionBar {
            actionBarBase = ActionBarSlot.content
            capturedActionBar = true
        }
        let previous = actionBarBase
        ActionBarSlot.content = { session, store, app in
            AnyView(VStack(spacing: 0) {
                if let previous { previous(session, store, app) }
                ComposeSessionActions(session: session, store: store, app: app)
                    .id("\(app.activationGeneration):\(session.id)")
            })
        }
    }
}
