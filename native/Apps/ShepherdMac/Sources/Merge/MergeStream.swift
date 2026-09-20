import SwiftUI
import ShepherdKit

struct MergeDetailTab: DetailTab {
    let id = "merge", systemImage = "arrow.triangle.merge", order = 600
    var title: String { L.t("native_merge_overview") }
    @MainActor func makeView(session: Session, store: SessionStore, app: AppModel) -> AnyView {
        guard let model = app.extension(MergeModel.self) else { return AnyView(EmptyView()) }
        return AnyView(MergeSessionView(app: app, session: session, store: store, model: model)
            .id("\(app.activationGeneration):\(session.id)"))
    }
}
struct MergeLauncher: View {
    let app: AppModel
    var body: some View {
        if let store = app.store, let model = app.extension(MergeModel.self) {
            @Bindable var model = model
            Button(L.t("native_merge_overview")) { model.showOverview = true }
                .sheet(isPresented: $model.showOverview) {
                    MergeOverviewView(app: app, store: store, model: model)
                        .id(app.activationGeneration).frame(minWidth: 620, minHeight: 440)
                }
        }
    }
}
@MainActor enum MergeStream {
    private static var wrapped = false
    static func installScene() {
        CommandRegistry.register(.init(id: "merge.overview", menu: .session, order: 600,
            titleKey: "native_merge_overview", isEnabled: { $0.extension(MergeModel.self) != nil },
            action: { $0.extension(MergeModel.self)?.showOverview = true }))
    }
    static func install(_ app: AppModel) {
        app.register(MergeModel.self)
        DetailTabRegistry.register(MergeDetailTab())
        guard !wrapped else { return }
        // S0 calls after S3/S4/S10. Never turn a nil fallback sidebar into an empty sidebar.
        guard let sidebar = SidebarSlot.content else { return }
        let actions = ActionBarSlot.content
        SidebarSlot.content = { app in
            AnyView(VStack(spacing: 0) { sidebar(app); MergeLauncher(app: app) })
        }
        ActionBarSlot.content = { session, store, app in
            AnyView(HStack {
                if let actions { actions(session, store, app) }
                if let model = app.extension(MergeModel.self), let q = model.snapshot.queues[session.id] {
                    Label("\(MergeRules.resolved(q))/\(q.steps.count)", systemImage: "list.bullet.rectangle")
                        .accessibilityLabel(L.t("native_merge_queue"))
                }
            })
        }
        wrapped = true
    }
    // Call only alongside SidebarSlot.reset/ActionBarSlot.reset in serialized tests.
    static func resetForTests() { wrapped = false }
}
