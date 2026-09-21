
extension CoreStreamInstallers {
    public static func installActions(into app: AppModel) {
        app.register(ActionsModel.self)
        StreamRegistrations.requiredHost.actionBarSlot(app)
    }
}
