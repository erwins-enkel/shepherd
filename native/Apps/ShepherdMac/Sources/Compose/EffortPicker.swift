import SwiftUI

struct EffortPicker: View {
    @Bindable var model: ComposeModel
    var options: [String] { ["default"] + ComposeRunConfig.providerEfforts(model.provider, model: model.model) }

    static func label(_ effort: String) -> String {
        switch effort {
        case "low": L.t("effort_label_low")
        case "medium": L.t("effort_label_medium")
        case "high": L.t("effort_label_high")
        case "xhigh": L.t("effort_label_xhigh")
        case "max": L.t("effort_label_max")
        case "ultra": L.t("effort_label_ultra")
        default: L.t("effort_default")
        }
    }

    var body: some View {
        Picker(L.t("newtask_effort_label"), selection: $model.effort) {
            ForEach(options, id: \.self) { value in
                Text(verbatim: Self.label(value)).tag(value)
            }
        }
        .pickerStyle(.menu)
        .accessibilityIdentifier("compose.effort")
    }
}
