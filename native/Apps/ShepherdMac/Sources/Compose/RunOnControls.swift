import ShepherdAppCore
import ShepherdKit
import SwiftUI

/// Run on (#2776): Automatic — the server chooses the machine — or a machine the repo can run on.
/// Shown only while the server places tasks among machines; without one the composer is exactly
/// what it was. The web's `runOnSelect` in `NewTask.svelte`.
struct RunOnPicker: View {
    @Bindable var runOn: RunOnModel
    @State private var explaining = false

    private var current: String {
        guard let id = runOn.pickedID, let host = runOn.machines.first(where: { $0.instanceId == id })
        else { return L.t("newtask_runon_auto") }
        return PlacementCopy.machineLabel(host)
    }

    var body: some View {
        HStack(spacing: 4) {
            Menu {
                Button { runOn.pick = nil } label: { option(L.t("newtask_runon_auto"), on: runOn.pickedID == nil) }
                Divider()
                ForEach(runOn.machines, id: \.instanceId) { host in
                    Button { runOn.pick = host.instanceId } label: {
                        option(PlacementCopy.machineLabel(host), on: runOn.pickedID == host.instanceId)
                    }
                }
            } label: {
                Text(verbatim: current).lineLimit(1).frame(maxWidth: 200)
            }
            .fixedSize()
            .accessibilityLabel(L.t("newtask_runon_label"))
            .accessibilityValue(current)
            .accessibilityIdentifier("compose.runOn")
            Button { explaining = true } label: { Image(systemName: "info.circle") }
                .buttonStyle(.borderless)
                .help(L.t("tooltip_runon_title"))
                .accessibilityLabel(L.t("tooltip_runon_title"))
                .popover(isPresented: $explaining) { RemoteExplanationView(explanation: PlacementCopy.runOnExplanation()) }
        }
    }

    @ViewBuilder private func option(_ title: String, on: Bool) -> some View {
        if on { Label(title, systemImage: "checkmark") } else { Text(verbatim: title) }
    }
}

/// What the task needs and where it will run (#2776): the requirement chips, what was read from
/// the task (and the question when it was unclear), the reason, and that a machine starts from the
/// pushed base. Nothing while the machine choice is not available.
struct RunOnNotices: View {
    @Bindable var model: ComposeModel

    var body: some View {
        if model.runOn.available {
            VStack(alignment: .leading, spacing: 6) {
                RequirementChips(runOn: model.runOn)
                DerivationLine(model: model)
                PlacementLine(runOn: model.runOn)
                if let target = model.runOn.remoteTarget {
                    Text(verbatim: L.t("newtask_runon_notice", target.name, model.repoBranches.baseBranch))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .font(.caption)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("compose.runOnNotices")
        }
    }
}

/// The task's requirements as chips: remove one, or add one from the vocabulary.
struct RequirementChips: View {
    @Bindable var runOn: RunOnModel

    private var options: [String] { PlacementCopy.requirementOptions.filter { !runOn.requirements.contains($0) } }

    var body: some View {
        HStack(spacing: 6) {
            Text(verbatim: PlacementCopy.plain(L.t("newtask_requirements_label"))).foregroundStyle(.secondary)
            if runOn.requirements.isEmpty {
                Text(verbatim: L.t("newtask_requirements_none")).foregroundStyle(.secondary)
            }
            ForEach(runOn.requirements, id: \.self) { id in
                let label = PlacementCopy.capabilityLabel(id)
                HStack(spacing: 3) {
                    Text(verbatim: label)
                    Button { runOn.removeRequirement(id) } label: { Image(systemName: "xmark") }
                        .buttonStyle(.borderless)
                        .accessibilityLabel(L.t("newtask_requirements_remove", label))
                }
                .padding(.horizontal, 6).padding(.vertical, 2)
                .overlay(RoundedRectangle(cornerRadius: 4).stroke(ShepherdPalette.line))
            }
            if !options.isEmpty {
                Menu(L.t("newtask_requirements_add")) {
                    ForEach(options, id: \.self) { id in
                        Button(PlacementCopy.capabilityLabel(id)) { runOn.addRequirement(id) }
                    }
                }
                .fixedSize()
                .accessibilityIdentifier("compose.requirements.add")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L.t("newtask_requirements_aria"))
        .accessibilityIdentifier("compose.requirements")
    }
}

/// What was read from the task: while it reads, what it found, the question when the description
/// was unclear — nothing starts before it is answered — or that nothing could be read.
struct DerivationLine: View {
    @Bindable var model: ComposeModel
    @State private var explaining = false

    var body: some View {
        if model.runOn.deriveApplies {
            if model.requirementsPending {
                Text(verbatim: L.t("newtask_derive_pending")).foregroundStyle(.secondary)
            } else if let derivation = model.derivation {
                switch derivation.status.rawValue {
                case "derived":
                    let found = (derivation.requirements ?? []).map(\.rawValue)
                    Button { explaining = true } label: {
                        Text(verbatim: found.isEmpty ? L.t("newtask_derive_none")
                            : L.t("newtask_derive_found", PlacementCopy.capabilityList(found)))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .popover(isPresented: $explaining) {
                        RemoteExplanationView(explanation: PlacementCopy.derivedExplanation())
                    }
                case "unclear":
                    question(derivation)
                case "skipped":
                    EmptyView()
                default:
                    Text(verbatim: L.t("newtask_derive_failed")).foregroundStyle(ShepherdPalette.warn)
                }
            }
        }
    }

    private func question(_ derivation: RequirementsDerivation) -> some View {
        HStack(spacing: 6) {
            Text(verbatim: L.t("newtask_derive_question")).foregroundStyle(ShepherdPalette.warn)
            ForEach(Array((derivation.options ?? []).enumerated()), id: \.offset) { _, option in
                let ids = option.map(\.rawValue)
                Button(ids.isEmpty ? L.t("newtask_derive_option_none") : PlacementCopy.capabilityList(ids)) {
                    model.runOn.setRequirements(ids)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L.t("newtask_derive_question"))
        .accessibilityIdentifier("compose.derive.question")
    }
}

/// Where the task will run and why, before it is submitted — the server's preview of the very
/// choice the create makes. A refusal or a machine out of reach reads as a warning.
struct PlacementLine: View {
    let runOn: RunOnModel
    @State private var explaining = false

    var body: some View {
        if let preview = runOn.currentPreview {
            if let placement = preview.placement {
                let wait = preview.wait
                Button { explaining = true } label: {
                    Text(verbatim: wait.map { PlacementCopy.waits(placement, $0) } ?? PlacementCopy.runsOn(placement))
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .buttonStyle(.plain)
                .foregroundStyle(wait == nil ? Color.secondary : ShepherdPalette.warn)
                .accessibilityIdentifier("compose.placement")
                .popover(isPresented: $explaining) {
                    RemoteExplanationView(explanation: wait.map { PlacementCopy.waitExplanation(placement, $0) }
                        ?? PlacementCopy.explanation(placement))
                }
            } else if let refusal = preview.refusal {
                Text(verbatim: PlacementCopy.refusal(MachineRefusal(refusal)))
                    .foregroundStyle(ShepherdPalette.warn)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("compose.placement")
            }
        } else if runOn.previewFailed {
            Text(verbatim: L.t("placement_preview_failed")).foregroundStyle(.secondary)
        } else {
            Text(verbatim: L.t("placement_choosing")).foregroundStyle(.secondary)
        }
    }
}

/// Why a session runs where it runs (#2776): the reason, its explanation on click.
struct PlacementReason: View {
    let placement: MachinePlacement
    @State private var explaining = false

    var body: some View {
        Button { explaining = true } label: {
            Text(verbatim: PlacementCopy.reason(placement)).lineLimit(1)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .help(L.t("tooltip_placement_title", placement.target.name))
        .accessibilityIdentifier("placement-reason")
        .popover(isPresented: $explaining) { RemoteExplanationView(explanation: PlacementCopy.explanation(placement)) }
    }
}
