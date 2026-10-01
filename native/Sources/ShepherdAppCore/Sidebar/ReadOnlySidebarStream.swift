import ShepherdKit

extension CoreStreamInstallers {
    /// Host-independent composition for the iOS metadata sidebar. All models use the
    /// store's existing event fan-out; no terminal, command UI or Mac host is installed.
    @MainActor
    public static func installReadOnlySidebar(into app: AppModel) {
        app.allowsQueueRecomputation = false
        app.register(SidebarModel.self)
        // Reuse the reconciled recap stream; no action presentation is installed.
        app.register(ActionsModel.self)
        SessionSignals.connect(app)
        app.register(PlanModel.self)
        PlanSignals.planReviewing = { [weak app] id in
            app?.extension(PlanModel.self)?.reviewing.contains(id) ?? false
        }
        HerdStream.install(app)
        app.register(QueuesModel.self)
        app.register(MergeModel.self)
        app.register(ReadOnlySidebarRecovery.self)
    }
}
