
extension CoreStreamInstallers {
    public static func installSidebar(into app: AppModel) {
        app.register(SidebarModel.self)
        // The machine groups' tasks that are not settled (#2776).
        app.register(RemoteDispatchesModel.self)
        StreamRegistrations.requiredHost.sidebarSlot(app)
    }
}
