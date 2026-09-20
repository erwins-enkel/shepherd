import SwiftUI
import ShepherdKit

struct SettingsPaneEntry: SettingsPane {
    let id: String
    let titleKey: StaticString
    let systemImage: String
    let order: Int
    var title: String {L.t(titleKey)}
    @MainActor static func notifications(in app: AppModel) -> NotificationsModel? {
        app.extension(NotificationsModel.self)
    }
    @MainActor func makeView(app: AppModel) -> AnyView {
        AnyView(Group {
            if id == "general" {
                ScrollView {
                    SettingsAppearanceView()
                    if let model = app.extension(SettingsModel.self), let store = app.store {
                        SettingsGeneralView(model:model,client:store.client)
                    }
                }
            } else if id == "notifications", let model = Self.notifications(in: app) {
                VStack {
                    NotificationSettingsView(model:model,profileName:app.activeProfile?.name ?? "")
                    if let settings = app.extension(SettingsModel.self), let client = app.store?.client {
                        Toggle(L.t("native_settings_reduced_push"),isOn:Binding(
                            get:{settings.snapshot?.settings.reducedPushMode == true},
                            set:{settings.patch(.init(reducedPushMode:$0),client:client)}))
                            .disabled(settings.busy || settings.snapshot == nil)
                        if let error = settings.error {
                            Text(verbatim: error).foregroundStyle(.red)
                                .accessibilityIdentifier("settings-notification-error")
                        }
                    }
                }.padding()
            } else if let model = app.extension(SettingsModel.self), let store = app.store {
                switch id {
                case "workspace": SettingsWorkspaceView(model:model,client:store.client)
                case "clis": SettingsGeneralView(model:model,client:store.client,cli:true)
                case "access": SettingsAccessView(app:app,settings:model)
                case "diagnose": SettingsDiagnoseView(model:model,client:store.client)
                default: EmptyView()
                }
            } else { Text(L.t("native_settings_connect")) }
        }.id(app.activationGeneration))
    }
}
@MainActor enum SettingsFeature {
    static func installScene() {
        let panes: [(String,StaticString,String)] = [
            ("general","native_settings_general","gearshape"),
            ("notifications","native_settings_notifications","bell"),
            ("workspace","native_settings_workspace","folder"),
            ("clis","native_settings_clis","terminal"),
            ("access","native_settings_access","key"),
            ("diagnose","native_settings_diagnose","stethoscope")]
        for (index,pane) in panes.enumerated() {
            SettingsPaneRegistry.register(SettingsPaneEntry(id:pane.0,titleKey:pane.1,systemImage:pane.2,order:index*100))
        }
        CommandRegistry.register(.init(id:"settings.palette",menu:.view,order:0,
            titleKey:"native_settings_command_palette",shortcut:.init("k"),
            action:{_ in SettingsPresentation.shared.palette = true}))
        // ⌘, belongs to the SwiftUI Settings scene; do not install a second shortcut.
        CommandRegistry.register(.init(id:"settings.open",menu:.window,order:100,
            titleKey:"native_settings_open",action:{_ in SettingsPresentation.shared.openSettingsRequest += 1}))
        CommandRegistry.register(.init(id:"settings.refresh",menu:.help,order:100,
            titleKey:"native_settings_refresh_diagnostics",isEnabled:{$0.extension(SettingsModel.self) != nil},
            action:{$0.extension(SettingsModel.self)?.reload()}))
    }
    static func install(_ app: AppModel) {
        app.register(SettingsModel.self)
        app.register(SettingsReadyModel.self)
    }
}
