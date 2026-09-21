
extension CoreStreamInstallers {
    public static func installTerminal(into app: AppModel) {
        StreamRegistrations.requiredHost.terminalTab(app)
        app.register(TerminalController.self)
    }
}
