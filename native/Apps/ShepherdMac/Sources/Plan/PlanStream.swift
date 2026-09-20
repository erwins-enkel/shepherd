import ShepherdKit
import SwiftUI

@MainActor
enum PlanSignals {
    static var planReviewing: (String) -> Bool = { _ in false }
}

enum PlanStream {
    /// S0-int: install this in the model pass before assigning HerdSignals.planReviewing
    /// from PlanSignals.planReviewing. That assignment copies the closure; doing it first
    /// permanently copies the conservative default. Install notification/attention consumers
    /// before their activation-scoped observer joins the S7 and S8 attention sets.
    @MainActor
    static func install(_ app: AppModel) {
        app.register(PlanModel.self)
        DetailTabRegistry.register(PlanDetailTab())
        SessionSignals.planQuestionsUnanswered = { [weak app] id in
            app?.extension(PlanModel.self)?.questionsUnanswered(id) ?? false
        }
        PlanSignals.planReviewing = { [weak app] id in
            app?.extension(PlanModel.self)?.reviewing.contains(id) ?? false
        }
    }
}

struct PlanDetailTab: DetailTab {
    let id = "plan"
    var title: String { L.t("planpanel_title") }
    let systemImage = "list.bullet.rectangle"
    let order = 500

    @MainActor
    func makeView(session: Session, store: SessionStore, app: AppModel) -> AnyView {
        guard let model = app.extension(PlanModel.self) else { return AnyView(EmptyView()) }
        return AnyView(PlanTabView(
            session: session, model: model, writer: .live(store.client), answerWriter: .live(session: session, store: store, app: app),
            isCurrent: Self.currentSelection(session: session, store: store, app: app)))
    }

    @MainActor
    static func currentSelection(session: Session, store: SessionStore, app: AppModel) -> @MainActor () -> Bool {
        let activation = app.activationGeneration
        return { [weak app, weak store] in
            guard let app, let store, app.activationGeneration == activation else { return false }
            // Selection changes before SwiftUI delivers onDisappear. Guard both queued
            // taps and suspended completions during that interval.
            return ActionBarView.isCurrent(session: session, store: store, app: app)
        }
    }
}
