import ShepherdAppCore
import SwiftUI
import Observation
import ShepherdKit

private struct SettingsMotionKey: EnvironmentKey { static let defaultValue = false }
private struct SettingsShapesKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    var shepherdReduceMotion: Bool {
        get {self[SettingsMotionKey.self]}
        set {self[SettingsMotionKey.self] = newValue}
    }
    var shepherdDifferentiateWithoutColor: Bool {
        get {self[SettingsShapesKey.self]}
        set {self[SettingsShapesKey.self] = newValue}
    }
}
struct SettingsStatusShape: ViewModifier {
    let status: SessionStatus
    @Environment(\.shepherdDifferentiateWithoutColor) private var shapes
    private var symbol: String {
        switch status.known {
        case .done: "checkmark.circle"
        case .blocked: "exclamationmark.triangle"
        case .running: "arrow.triangle.2.circlepath"
        case .archived: "archivebox"
        default: "circle"
        }
    }
    func body(content: Content) -> some View {
        HStack {content; if shapes {Image(systemName:symbol).accessibilityHidden(true)}}
    }
}

struct SettingsAppearanceView: View {
    @AppStorage("native.appearance.theme") private var theme = "system"
    @AppStorage("native.appearance.motion") private var motion = "system"
    @AppStorage("native.appearance.contrast") private var contrast = false
    @AppStorage("native.appearance.colorblind") private var colorblind = false
    var body: some View {
        Form {
            Picker(L.t("native_settings_theme"),selection:$theme) {
                Text(L.t("native_settings_system")).tag("system")
                Text(L.t("native_settings_light")).tag("light")
                Text(L.t("native_settings_dark")).tag("dark")
            }
            Picker(L.t("native_settings_motion"),selection:$motion) {
                Text(L.t("native_settings_system")).tag("system")
                Text(L.t("native_settings_full_motion")).tag("full")
                Text(L.t("native_settings_reduced_motion")).tag("reduced")
            }
            Toggle(L.t("native_settings_contrast"),isOn:$contrast)
            Toggle(L.t("native_settings_colorblind"),isOn:$colorblind)
        }
    }
}
struct SettingsRootModifier: ViewModifier {
    let app: AppModel
    var hostsPalette = true
    @Environment(\.openSettings) private var openSettings
    @Environment(\.accessibilityReduceMotion) private var systemMotion
    @Environment(\.accessibilityDifferentiateWithoutColor) private var systemShapes
    @AppStorage("native.appearance.theme") private var theme = "system"
    @AppStorage("native.appearance.motion") private var motion = "system"
    @AppStorage("native.appearance.contrast") private var contrast = false
    @AppStorage("native.appearance.colorblind") private var colorblind = false
    func body(content: Content) -> some View {
        @Bindable var presentation = SettingsPresentation.shared
        content
            .preferredColorScheme(theme == "dark" ? .dark : theme == "light" ? .light : nil)
            .contrast(contrast ? 1.15 : 1)
            .environment(\.shepherdReduceMotion, motion == "system" ? systemMotion : motion == "reduced")
            .transaction { transaction in
                if motion == "reduced" || (motion == "system" && systemMotion) {
                    transaction.disablesAnimations = true; transaction.animation = nil
                }
            }
            .environment(\.shepherdDifferentiateWithoutColor, colorblind || systemShapes)
            .sheet(isPresented: Binding(get:{hostsPalette && presentation.palette},set:{presentation.palette = $0})) {
                SettingsCommandPalette(app:app).frame(width:560,height:420)
            }
            .onChange(of:presentation.openSettingsRequest) { if hostsPalette { openSettings() } }
            .onChange(of:app.activationGeneration) { presentation.palette = false }
    }
}
