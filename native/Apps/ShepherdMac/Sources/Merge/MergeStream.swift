import ShepherdAppCore
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
    // The slot owns its composition. Replacing/resetting a slot releases that owner,
    // so a complete installer pass can wrap the new predecessor. A process-wide Bool
    // survives that replacement and incorrectly skips the next window's composition.
    private static weak var sidebarComposition: SidebarComposition?
    private static weak var actionComposition: ActionComposition?
    static func installScene() {
        CommandRegistry.register(.init(id: "merge.overview", menu: .session, order: 600,
            titleKey: "native_merge_overview", isEnabled: { $0.extension(MergeModel.self) != nil },
            action: { $0.extension(MergeModel.self)?.showOverview = true }))
    }
    static func install(_ app: AppModel) {
        MacStreamHost.configure()
        CoreStreamInstallers.installMerge(into: app)
    }

    @MainActor
    static func installPresentation(_ app: AppModel) {
        DetailTabRegistry.register(MergeDetailTab())
        // S0 calls after S3/S4/S10. Never turn a nil fallback sidebar into an empty sidebar.
        guard let sidebar = SidebarSlot.content else { return }
        if sidebarComposition == nil {
            let composition = SidebarComposition(content: sidebar)
            sidebarComposition = composition
            SidebarSlot.content = { app in composition.render(app) }
        }
        if actionComposition == nil {
            let composition = ActionComposition(content: ActionBarSlot.content)
            actionComposition = composition
            ActionBarSlot.content = { session, store, app in composition.render(session, store, app) }
        }
    }

    @MainActor private final class SidebarComposition {
        let content: @MainActor (AppModel) -> AnyView
        init(content: @escaping @MainActor (AppModel) -> AnyView) { self.content = content }
        func render(_ app: AppModel) -> AnyView {
            AnyView(VStack(spacing: 0) { content(app); MergeLauncher(app: app) })
        }
    }
    @MainActor private final class ActionComposition {
        let content: (@MainActor (Session, SessionStore, AppModel) -> AnyView)?
        init(content: (@MainActor (Session, SessionStore, AppModel) -> AnyView)?) {
            self.content = content
        }
        func render(_ session: Session, _ store: SessionStore, _ app: AppModel) -> AnyView {
            AnyView(HStack {
                if let content { content(session, store, app) }
                if let model = app.extension(MergeModel.self), let q = model.snapshot.queues[session.id] {
                    Label("\(MergeRules.resolved(q))/\(q.steps.count)", systemImage: "list.bullet.rectangle")
                        .accessibilityLabel(L.t("native_merge_queue"))
                }
            })
        }
    }
}
