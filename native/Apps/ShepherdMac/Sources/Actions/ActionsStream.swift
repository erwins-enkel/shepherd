import ShepherdKit
import SwiftUI

/// This stream's single entry point. The integration lane adds exactly one line to
/// `StreamRegistrations.installAll(into:)`:
///
///     ActionsStream.install(app)
///
/// Idempotent: `AppModel.register` is keyed by extension type, and the slot assignment is a
/// plain overwrite, so the launch task may run it more than once.
@MainActor
enum ActionsStream {
    static func install(_ app: AppModel) {
        app.register(ActionsModel.self)
        ActionBarSlot.content = { session, store, app in
            // A bar with no live extension has no recap and no seams to read, which happens
            // only between `register` and the first activation. Rendering nothing is right:
            // the actions themselves need the model's rules.
            guard let model = app.extension(ActionsModel.self) else { return AnyView(EmptyView()) }
            return AnyView(
                ActionBarView(session: session, store: store, model: model, app: app))
        }
        Log.app.info("actions stream installed")
    }
}
