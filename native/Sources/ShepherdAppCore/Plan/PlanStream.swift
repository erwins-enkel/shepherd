import ShepherdKit
import SwiftUI

@MainActor
enum PlanSignals {
    static var planReviewing: (String) -> Bool = { _ in false }
}

extension CoreStreamInstallers {
    /// S0-int: install this in the model pass before assigning HerdSignals.planReviewing
    /// from PlanSignals.planReviewing. That assignment copies the closure; doing it first
    /// permanently copies the conservative default. Install notification/attention consumers
    /// before their activation-scoped observer joins the S7 and S8 attention sets.
    @MainActor
    public static func installPlan(into app: AppModel) {
        app.register(PlanModel.self)
        StreamRegistrations.requiredHost.planTab(app)
        SessionSignals.planQuestionsUnanswered = { [weak app] id in
            app?.extension(PlanModel.self)?.questionsUnanswered(id) ?? false
        }
        PlanSignals.planReviewing = { [weak app] id in
            app?.extension(PlanModel.self)?.reviewing.contains(id) ?? false
        }
    }
}
