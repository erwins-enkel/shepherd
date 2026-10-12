import SwiftUI
import ShepherdAppCore
import ShepherdKit

/// A server the app is connected to, as a Run on option of the multi-server composer (#2776).
struct IOSRunOnServer: Identifiable, Equatable {
    let profileID: UUID
    let name: String
    /// Its instance ID (`GET /api/instance`); nil until it answers.
    let instanceID: String?
    var id: UUID { profileID }
}

/// What a composer moving to another server takes along: the pick and the operator's chips.
struct IOSRunOnCarry: Equatable {
    let pick: String?
    let requirements: [String]
    let touched: Bool
}

/// The servers of the multi-server composer: the one it submits to (the entry) and the other
/// connected servers that carry the repo.
struct IOSRunOnServers {
    let entry: IOSRunOnServer
    let others: [IOSRunOnServer]
    /// Moves the composer to `server`, taking `carry` along.
    let switchTo: (IOSRunOnServer, IOSRunOnCarry) -> Void
}

/// One Run on choice (#2776). The composer submits through one server and leaves the machine to
/// it: Automatic sends no machine. An override names one of that server's machines, or moves the
/// composer to another connected server the entry does not reach as a machine — the server picker
/// the composer had before (#2755, #2833).
enum IOSRunOnOption: Identifiable, Equatable {
    case automatic
    case machine(SessionHost)
    case server(IOSRunOnServer)
    case entry(IOSRunOnServer)

    var id: String {
        switch self {
        case .automatic: "automatic"
        case .machine(let host): "machine:\(host.instanceId)"
        case .server(let server): "server:\(server.profileID)"
        case .entry(let server): "entry:\(server.profileID)"
        }
    }

    var label: String {
        switch self {
        case .automatic: L.t("newtask_runon_auto")
        case .machine(let host): PlacementCopy.machineLabel(host)
        case .server(let server), .entry(let server): server.name
        }
    }

    /// While the entry places tasks among machines: Automatic, its machines, then each other
    /// server it does not list as a machine. Without the choice: the entry and the other servers,
    /// as the server picker was. Fewer than two options means there is nothing to choose.
    static func options(active: Bool, machines: [SessionHost], servers: IOSRunOnServers?) -> [IOSRunOnOption] {
        if active {
            let known = Set(machines.map(\.instanceId))
            let others = (servers?.others ?? []).filter { server in
                server.instanceID.map { !known.contains($0) } ?? true
            }
            return [.automatic] + machines.map(IOSRunOnOption.machine) + others.map(IOSRunOnOption.server)
        }
        guard let servers else { return [] }
        return [.entry(servers.entry)] + servers.others.map(IOSRunOnOption.server)
    }
}

/// Run on in the iOS composer: shown only when there is something to choose.
struct IOSRunOnPicker: View {
    @Bindable var runOn: RunOnModel
    let servers: IOSRunOnServers?
    @Environment(\.composeRendering) private var rendering

    private var options: [IOSRunOnOption] {
        IOSRunOnOption.options(active: runOn.active, machines: runOn.machines, servers: servers)
    }

    private var current: String {
        guard runOn.active else { return servers?.entry.name ?? "" }
        guard let id = runOn.pickedID, let host = runOn.machines.first(where: { $0.instanceId == id })
        else { return L.t("newtask_runon_auto") }
        return PlacementCopy.machineLabel(host)
    }

    private func isCurrent(_ option: IOSRunOnOption) -> Bool {
        switch option {
        case .automatic: runOn.pickedID == nil
        case .machine(let host): runOn.pickedID == host.instanceId
        case .entry: true
        case .server: false
        }
    }

    private func choose(_ option: IOSRunOnOption) {
        switch option {
        case .automatic: runOn.pick = nil
        case .machine(let host): runOn.pick = host.instanceId
        case .entry: break
        case .server(let server):
            servers?.switchTo(server, IOSRunOnCarry(pick: server.instanceID, requirements: runOn.requirements,
                                                    touched: runOn.requirementsTouched))
        }
    }

    var body: some View {
        let choices = options
        if choices.count > 1 {
            let label = HStack {
                Text(verbatim: L.t("newtask_runon_label"))
                Spacer()
                Text(verbatim: current).lineLimit(1).truncationMode(.tail)
                Image(systemName: "chevron.down")
            }.font(.system(.caption, design: .monospaced)).foregroundStyle(ComposePalette.ink)
                .frame(minHeight: 44).padding(.horizontal, 10)
                .overlay { RoundedRectangle(cornerRadius: 6).stroke(ComposePalette.line) }
            Group {
                if rendering { label }
                else {
                    StableMenu(value: choices.map { "\($0.id)|\(isCurrent($0))" }) {
                        ForEach(choices) { option in
                            Button { choose(option) } label: {
                                if isCurrent(option) { Label(option.label, systemImage: "checkmark") }
                                else { Text(verbatim: option.label) }
                            }
                        }
                    } label: { label }.equatable()
                }
            }
            .accessibilityLabel(L.t("newtask_runon_label"))
            .accessibilityValue(current)
            .accessibilityIdentifier("compose.runOn")
        }
    }
}

/// An explanation to show in a sheet: a descriptive title, a short summary and labelled sections.
struct IOSExplanation: Identifiable {
    let explanation: RemoteExplanation
    var id: String { explanation.title }
}

/// What the task needs and where it will run (#2776): the requirement chips, what was read from
/// the task (and the question when it was unclear), the reason, and that a machine starts from
/// the pushed base. Nothing while the machine choice is not available.
struct IOSRunOnNotices: View {
    @Bindable var model: ComposeModel
    let explain: (RemoteExplanation) -> Void
    @Environment(\.composeRendering) private var rendering

    private var options: [String] {
        PlacementCopy.requirementOptions.filter { !model.runOn.requirements.contains($0) }
    }

    var body: some View {
        if model.runOn.available {
            VStack(alignment: .leading, spacing: 8) {
                chips
                derivation
                placement
                if let target = model.runOn.remoteTarget {
                    Text(verbatim: L.t("newtask_runon_notice", target.name, model.repoBranches.baseBranch))
                        .foregroundStyle(ComposePalette.muted)
                }
            }
            .font(.system(.caption, design: .monospaced))
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("compose.runOnNotices")
        }
    }

    private var chips: some View {
        HStack(spacing: 6) {
            Text(verbatim: PlacementCopy.plain(L.t("newtask_requirements_label"))).foregroundStyle(ComposePalette.muted)
            if model.runOn.requirements.isEmpty {
                Text(verbatim: L.t("newtask_requirements_none")).foregroundStyle(ComposePalette.faint)
            }
            ForEach(model.runOn.requirements, id: \.self) { id in
                Button { model.runOn.removeRequirement(id) } label: {
                    Text(verbatim: "\(PlacementCopy.capabilityLabel(id)) ×")
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 8).frame(minHeight: 32)
                .overlay { RoundedRectangle(cornerRadius: 6).stroke(ComposePalette.line) }
                .accessibilityLabel(L.t("newtask_requirements_remove", PlacementCopy.capabilityLabel(id)))
            }
            if !options.isEmpty, !rendering {
                StableMenu(value: options) {
                    ForEach(options, id: \.self) { id in
                        Button(PlacementCopy.capabilityLabel(id)) { model.runOn.addRequirement(id) }
                    }
                } label: {
                    Text(verbatim: L.t("newtask_requirements_add")).frame(minHeight: 32)
                }.equatable()
                .accessibilityIdentifier("compose.requirements.add")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L.t("newtask_requirements_aria"))
        .accessibilityIdentifier("compose.requirements")
    }

    @ViewBuilder private var derivation: some View {
        if model.runOn.deriveApplies {
            if model.requirementsPending {
                Text(verbatim: L.t("newtask_derive_pending")).foregroundStyle(ComposePalette.muted)
            } else if let derivation = model.derivation {
                switch derivation.status.rawValue {
                case "derived":
                    let found = (derivation.requirements ?? []).map(\.rawValue)
                    Button { explain(PlacementCopy.derivedExplanation()) } label: {
                        Text(verbatim: found.isEmpty ? L.t("newtask_derive_none")
                            : L.t("newtask_derive_found", PlacementCopy.capabilityList(found)))
                            .multilineTextAlignment(.leading)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(ComposePalette.muted)
                case "unclear":
                    VStack(alignment: .leading, spacing: 6) {
                        Text(verbatim: L.t("newtask_derive_question")).foregroundStyle(ComposePalette.amber)
                        ForEach(Array((derivation.options ?? []).enumerated()), id: \.offset) { _, option in
                            let ids = option.map(\.rawValue)
                            Button(ids.isEmpty ? L.t("newtask_derive_option_none") : PlacementCopy.capabilityList(ids)) {
                                model.runOn.setRequirements(ids)
                            }
                            .buttonStyle(ComposeControlStyle())
                        }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("compose.derive.question")
                case "skipped":
                    EmptyView()
                default:
                    Text(verbatim: L.t("newtask_derive_failed")).foregroundStyle(ComposePalette.amber)
                }
            }
        }
    }

    @ViewBuilder private var placement: some View {
        if let preview = model.runOn.currentPreview {
            if let placement = preview.placement {
                let wait = preview.wait
                Button {
                    explain(wait.map { PlacementCopy.waitExplanation(placement, $0) } ?? PlacementCopy.explanation(placement))
                } label: {
                    Text(verbatim: wait.map { PlacementCopy.waits(placement, $0) } ?? PlacementCopy.runsOn(placement))
                        .multilineTextAlignment(.leading)
                }
                .buttonStyle(.plain)
                .foregroundStyle(wait == nil ? ComposePalette.muted : ComposePalette.amber)
                .accessibilityIdentifier("compose.placement")
            } else if let refusal = preview.refusal {
                Text(verbatim: PlacementCopy.refusal(MachineRefusal(refusal))).foregroundStyle(ComposePalette.amber)
                    .accessibilityIdentifier("compose.placement")
            }
        } else if model.runOn.previewFailed {
            Text(verbatim: L.t("placement_preview_failed")).foregroundStyle(ComposePalette.muted)
        } else {
            Text(verbatim: L.t("placement_choosing")).foregroundStyle(ComposePalette.muted)
        }
    }
}

/// The explanation sheet: title, summary and labelled sections.
struct IOSExplanationSheet: View {
    let explanation: RemoteExplanation
    let close: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(verbatim: explanation.summary)
                    ForEach(explanation.sections) { section in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(verbatim: section.label).bold()
                            Text(verbatim: section.text)
                        }
                    }
                }
                .font(.system(.callout, design: .monospaced))
                .foregroundStyle(ComposePalette.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
            }
            .background(ComposePalette.bg)
            .navigationTitle(explanation.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(L.t("common_close"), action: close) } }
        }
        .presentationDetents([.medium, .large])
        .preferredColorScheme(.dark)
    }
}
