import ShepherdKit
import SwiftUI

@MainActor
enum ComposeStream {
    /// Owned by the installed closure, so resetting/replacing the slot releases its base.
    /// Keeping this reference weak avoids a separate global cache surviving resetStreamSeams().
    private final class ActionBarComposition {
        let base: (@MainActor (Session, SessionStore, AppModel) -> AnyView)?
        init(base: (@MainActor (Session, SessionStore, AppModel) -> AnyView)?) { self.base = base }
    }
    private static weak var actionBarComposition: ActionBarComposition?

    static func resetActionsForTesting() { actionBarComposition = nil }
    static func install(_ app: AppModel) {
        // Integration owns the caller. The existing NewSessionSheet remains the empty-slot fallback.
        NewSessionSlot.content = { app in AnyView(ComposeSheet().environment(app)) }
        // Reuse the base while our closure is installed; a preceding stream's new
        // assignment or reset drops that closure and lets the next pass capture its new base.
        let composition = actionBarComposition ?? ActionBarComposition(base: ActionBarSlot.content)
        actionBarComposition = composition
        ActionBarSlot.content = { [composition] session, store, app in
            AnyView(VStack(spacing: 0) {
                if let previous = composition.base { previous(session, store, app) }
                ComposeSessionActions(session: session, store: store, app: app)
                    .id("\(app.activationGeneration):\(session.id)")
            })
        }
    }
}
