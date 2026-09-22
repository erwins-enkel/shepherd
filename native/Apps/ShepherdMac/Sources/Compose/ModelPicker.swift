import ShepherdAppCore
import Foundation
import ShepherdKit
import SwiftUI

/// The complete model · effort row and its cost/fit explanation. The sheet mounts this in Task 9.
struct ModelPicker: View {
    @Bindable var model: ComposeModel
    @FocusState private var pickerFocused: Bool

    var options: [String] {
        ["default"] + ComposeRunConfig.providerModels(model.provider).filter {
            ComposeRunConfig.available($0, provider: model.provider, fableAvailable: model.runDefaults.fableAvailable)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Picker(L.t("newtask_model_label"), selection: $model.model) {
                    ForEach(options, id: \.self) { value in
                        Text(verbatim: ModelGuidance.optionLabel(provider: model.provider, model: value)).tag(value)
                    }
                }
                .pickerStyle(.menu)
                .focused($pickerFocused)
                .onChange(of: model.focusRevision) { _, _ in
                    if model.focusTarget == "model" { pickerFocused = true }
                }
                .accessibilityIdentifier("compose.model")
                EffortPicker(model: model)
            }
            ModelGuidanceView(guidance: .value(provider: model.provider, model: model.model))
        }
    }
}
