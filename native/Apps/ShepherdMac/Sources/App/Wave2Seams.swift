import ShepherdAppCore
import ShepherdKit
import SwiftUI

/// Cross-stream projections only: every fact comes from the current activation's owners.
@MainActor
enum Wave2Seams {
    static func installPanels() {
        QueuesPanels.register(.owed) { AnyView(IntegratedOwedPanel()) }
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
