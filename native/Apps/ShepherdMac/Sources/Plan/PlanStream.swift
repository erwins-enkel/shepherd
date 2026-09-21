import ShepherdAppCore
import ShepherdKit
import SwiftUI

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
            return CurrentSessionSelection.isCurrent(session: session, store: store, app: app)
        }
    }
}

@MainActor
enum PlanStream {
    static func install(_ app: AppModel) {
        MacStreamHost.configure()
        CoreStreamInstallers.installPlan(into: app)
    }
}
