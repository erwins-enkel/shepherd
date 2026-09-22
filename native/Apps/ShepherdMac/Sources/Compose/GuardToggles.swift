import ShepherdAppCore
import Foundation
import SwiftUI

struct GuardToggles: View {
    @Bindable var model: ComposeModel

    // Read-only binding access must leave nil/inherit intact in the create request.
    var planGate: Binding<Bool> {
        Binding(get: { model.planGateEnabled }, set: { enabled in
            model.planGateEnabled = enabled
            model.planGateTouched = true
        })
    }

    var autopilot: Binding<Bool> {
        Binding(get: { model.autopilotEnabled }, set: { enabled in
            model.autopilotEnabled = enabled
            model.autopilotTouched = true
        })
    }

    /// The web glossary has no native surface; keep its visible labels, not its markup.
    static func label(_ markup: String) -> String {
        markup.replacingOccurrences(of: #"\[\[[^|\[\]]+\|([^\[\]]+)\]\]"#,
                                    with: "$1", options: .regularExpression)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(verbatim: L.t("newtask_group_guards")).font(.headline)
            ComposeGuards(model: model) {
                guardToggle(L.t("newtask_guard_plan_gate"), hint: L.t("newtask_plan_gate_hint"),
                            value: planGate, identifier: "compose.planGate")
                guardToggle(L.t("newtask_guard_autopilot"), hint: L.t("newtask_autopilot_hint"),
                            value: autopilot, identifier: "compose.autopilot")
            }
        }
        // Repo-default tips and GuardTimeline require S12's repo-config; follow up after integration.
    }

    private func guardToggle(_ title: String, hint: String, value: Binding<Bool>, identifier: String) -> some View {
        let status = value.wrappedValue ? L.t("newtask_toggle_on") : L.t("newtask_toggle_off")
        return Toggle(isOn: value) {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(verbatim: Self.label(title))
                    Text(verbatim: status).font(.caption).foregroundStyle(.secondary)
                }
                Text(verbatim: hint)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .toggleStyle(.switch)
        .accessibilityLabel(Self.label(title))
        .accessibilityValue(status)
        .accessibilityHint(hint)
        .accessibilityIdentifier(identifier)
    }
}
