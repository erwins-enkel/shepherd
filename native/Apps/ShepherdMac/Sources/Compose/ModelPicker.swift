import ShepherdAppCore
import Foundation
import ShepherdKit
import SwiftUI

/// Provider-aware model selection with compact cost and fit guidance.
struct ModelPicker: View {
    @Bindable var model: ComposeModel
    @FocusState private var pickerFocused: Bool

    var options: [String] {
        ["default"] + ComposeRunConfig.providerModels(model.provider).filter {
            ComposeRunConfig.available($0, provider: model.provider, fableAvailable: model.runDefaults.fableAvailable,
                                       mythosAvailable: model.runDefaults.mythosAvailable)
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
            }
            ModelGuidanceView(guidance: .value(provider: model.provider, model: model.model))
        }
    }
}
