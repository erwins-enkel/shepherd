import ShepherdAppCore
import ShepherdKit
import Foundation
import SwiftUI

struct GuardToggles: View {
    @Bindable var model: ComposeModel
    var repoConfig: RepoConfig?
    var repoConfigLoading = false
    var retryRepoDefaults: () -> Void = {}
    var openAutomation: (() -> Void)?

    // Read-only binding access must leave nil/inherit intact in the create request.
    var planGate: Binding<Bool> {
        Binding(get: { model.planGateEnabled }, set: {
            model.planGateEnabled = $0; model.planGateTouched = true
        })
    }
    var autopilot: Binding<Bool> {
        Binding(get: { model.autopilotEnabled }, set: {
            model.autopilotEnabled = $0; model.autopilotTouched = true
        })
    }
    static func label(_ markup: String) -> String {
        markup.replacingOccurrences(of: #"\[\[[^|\[\]]+\|([^\[\]]+)\]\]"#,
                                    with: "$1", options: .regularExpression)
    }
    private var timeline: GuardTimeline {
        .derive(planGate: model.planGateEnabled, autopilot: model.autopilotEnabled,
                provider: model.provider, baseBranch: model.repoBranches.baseBranch,
                repo: repoConfig.map(GuardTimeline.Repo.init))
    }
    var body: some View {
        if !model.modeLocked {
            VStack(alignment: .leading, spacing: 12) {
                ComposeSectionLabel(key: "newtask_group_guards")
                guardToggle(L.t("newtask_guard_plan_gate"), hint: L.t("newtask_plan_gate_hint"), value: planGate,
                            repoDefault: repoConfig?.planGateEnabled, effective: model.effectivePlanGate, identifier: "compose.planGate")
                    .modifier(ComposeKeycap(ids: ["plan-gate"]))
                guardToggle(L.t("newtask_guard_autopilot"), hint: L.t("newtask_autopilot_hint"), value: autopilot,
                            repoDefault: repoConfig?.autopilotEnabled, effective: model.effectiveAutopilot, identifier: "compose.autopilot")
                    .modifier(ComposeKeycap(ids: ["autopilot"]))
                Divider()
                if repoConfig == nil || repoConfigLoading {
                    HStack {
                        Text(verbatim: L.t(repoConfigLoading ? "common_loading" : "native_compose_repo_default_unknown"))
                            .foregroundStyle(.secondary)
                        if !repoConfigLoading {
                            Button(L.t("common_retry"), action: retryRepoDefaults)
                                .accessibilityIdentifier("compose.retryRepoDefaults")
                        }
                    }.font(.caption)
                } else {
                    DisclosureGroup(GuardTimeline.copy(timeline.headerKey)) {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(Array(timeline.steps.enumerated()), id: \.element.id) { index, step in
                                if step.repoScoped && index == timeline.steps.firstIndex(where: \.repoScoped) {
                                    Text(verbatim: L.t("guardtl_divider")).font(.caption2).foregroundStyle(.secondary)
                                        .padding(.top, 6)
                                }
                                HStack(alignment: .top, spacing: 6) {
                                    Text(verbatim: "\(index + 1).").monospacedDigit()
                                    Text(verbatim: GuardTimeline.copy("guardtl_marker_\(step.kind == .human ? "you" : step.kind.rawValue)"))
                                        .fontWeight(.semibold)
                                    Text(verbatim: GuardTimeline.copy(step.key))
                                    if step.repoScoped, let openAutomation {
                                        Button(action: openAutomation) { Image(systemName: "arrow.up.forward") }
                                            .buttonStyle(.plain)
                                            .accessibilityLabel(L.t("guardtl_open_automation"))
                                            .help(L.t("guardtl_open_automation"))
                                    }
                                }
                            }
                        }.padding(.top, 8)
                    }.font(.caption).accessibilityIdentifier("compose.guardTimeline")
                }
            }
        }
    }
    private func guardToggle(_ title: String, hint: String, value: Binding<Bool>, repoDefault: Bool?, effective: Bool?, identifier: String) -> some View {
        // SwiftUI's collection toggle renders the native mixed state for unresolved
        // inheritance. Reading it never turns nil/inherit into an explicit false.
        let states = Binding<[Bool]>(get: { effective.map { [$0] } ?? [false, true] },
                                     set: { if let choice = $0.first { value.wrappedValue = choice } })
        return Toggle(sources: states, isOn: \.self) {
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: Self.label(title))
                Text(verbatim: repoDefault.map {
                    $0 ? L.t("newtask_autopilot_repo_default_on") : L.t("newtask_autopilot_repo_default_off")
                } ?? (repoConfigLoading ? L.t("common_loading") : L.t("native_compose_repo_default_unknown"))).font(.caption2).foregroundStyle(.secondary)
            }
        }
        .toggleStyle(.switch).help(hint)
        .disabled(repoConfigLoading)
        .accessibilityLabel(Self.label(title)).accessibilityHint(hint)
        .accessibilityIdentifier(effective == nil ? "\(identifier).unknown" : identifier)
    }
}
