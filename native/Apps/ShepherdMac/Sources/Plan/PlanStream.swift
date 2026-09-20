import ShepherdKit
import SwiftUI

@MainActor
enum PlanSignals {
    static var planReviewing: (String) -> Bool = { _ in false }
}

enum PlanStream {
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
        let activation = app.activationGeneration
        return AnyView(PlanTabView(
            session: session, model: model, writer: .live(store.client), answerWriter: .live(store.client),
            isCurrent: { [weak app] in app?.activationGeneration == activation }))
    }
}
