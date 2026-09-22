extension CoreStreamInstallers {
    public static func installSettings(into app: AppModel) {
        app.register(BackendRecoveryModel.self)
        app.register(SettingsModel.self)
        app.register(SettingsReadyModel.self)
    }
}
