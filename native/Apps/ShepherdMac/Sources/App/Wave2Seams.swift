import ShepherdKit
import SwiftUI

/// Cross-stream projections only: every fact comes from the current activation's owners.
@MainActor
enum Wave2Seams {
    static func installPanels() {
        QueuesPanels.register(.owed) { AnyView(IntegratedOwedPanel()) }
    }

    static func connect(_ app: AppModel) {
        // QueuesStream's repeatable model pass also registers its fallback factories.
        installPanels()
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
            return plan.reviewing.contains(id) || plan.gates[id] != nil
        }
        MergeInputs.terminalEnded = { app, id in
            guard let herd = app.extension(HerdSignals.self) else { return true }
            return herd.claudeAlive[id] == false
        }
    }
}

struct IntegratedOwedPanel: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        Group {
            if let store = app.store, let merge = app.extension(MergeModel.self) {
                MergeOwedView(model: merge, client: store.client,
                    repos: app.extension(SidebarModel.self)?.activeRepos ?? [])
                    .id(app.activationGeneration)
            } else {
                OwedPanelView()
            }
        }
        .accessibilityIdentifier("queues-owed-panel")
    }
}
