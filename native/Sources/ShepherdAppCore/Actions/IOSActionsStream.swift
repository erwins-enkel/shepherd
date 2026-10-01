#if os(iOS)
import ShepherdKit

extension CoreStreamInstallers {
    /// iOS has its own presentation and no StreamHost. Reuse the same activation
    /// models and conservative merge inputs as the Mac installation.
    @MainActor
    public static func installIOSSessionActions(into app: AppModel) {
        app.register(ActionsModel.self)
        app.register(MergeModel.self)
        MergeInputs.git = { $0.extension(HerdSignals.self)?.git ?? [:] }
        MergeInputs.reviewing = { app, id in
            (app.extension(HerdSignals.self)?.isReviewing(id) ?? false)
                || (app.extension(PlanModel.self)?.reviewing.contains(id) ?? false)
        }
        MergeInputs.planReviewBlocked = { app, id in
            guard let plan = app.extension(PlanModel.self) else { return true }
            return !plan.hasLoadedSnapshot || plan.reviewing.contains(id) || plan.gates[id] != nil
        }
        MergeInputs.terminalEnded = { app, id in
            app.extension(HerdSignals.self)?.claudeAlive[id] != true
        }
    }
}
#endif
