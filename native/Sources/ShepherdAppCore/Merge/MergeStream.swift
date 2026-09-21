
extension CoreStreamInstallers {
    public static func installMerge(into app: AppModel) {
        app.register(MergeModel.self)
        StreamRegistrations.requiredHost.mergePresentation(app)
    }
}
