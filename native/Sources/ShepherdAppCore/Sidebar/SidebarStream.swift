
extension CoreStreamInstallers {
    public static func installSidebar(into app: AppModel) {
        app.register(SidebarModel.self)
        StreamRegistrations.requiredHost.sidebarSlot(app)
    }
}
