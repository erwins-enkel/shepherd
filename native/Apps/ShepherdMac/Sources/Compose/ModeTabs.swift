import ShepherdAppCore
import SwiftUI

/// Task 9 places these tabs in the complete sheet. Selection always changes the wire flags.
struct ModeTabs: View {
    @Bindable var model: ComposeModel

    var body: some View {
        Picker(L.t("newtask_group_mode"), selection: Binding(get: { model.mode }, set: { model.setMode($0) })) {
            ForEach(ComposeMode.allCases, id: \.self) { mode in
                Text(verbatim: mode.title).tag(mode)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .textCase(.uppercase)
        .accessibilityIdentifier("compose.mode")
    }
}

/// Wrap Task 6's guard controls so non-Code modes replace them with the existing explanation.
struct ComposeGuards<Controls: View>: View {
    let model: ComposeModel
    @ViewBuilder var controls: () -> Controls

    var body: some View {
        if let explanation = model.guardExplanation {
            Text(verbatim: explanation)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("compose.guardsExplanation")
        } else {
            controls()
        }
    }
}
