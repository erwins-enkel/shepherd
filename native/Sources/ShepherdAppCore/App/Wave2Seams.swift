import ShepherdKit

@MainActor
enum Wave2Seams {
    static func connect(_ app: AppModel) {
        // QueuesStream's repeatable model pass also registers its fallback factories.
        StreamRegistrations.requiredHost.wave2Panels()
        SessionSignals.manualStepsOutstanding = { [weak app] in
            app?.extension(MergeModel.self)?.outstanding ?? [:]
        }
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
            guard let herd = app.extension(HerdSignals.self) else { return true }
            return herd.claudeAlive[id] != true
        }
    }
}
