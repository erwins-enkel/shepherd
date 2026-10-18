import SwiftUI
import ShepherdAppCore
import ShepherdKit

struct IOSEpicModePicker: View {
    @Binding var mode: Components.Schemas.EpicRunPatch.ModePayload
    var body: some View {
        HStack(spacing: 0) {
            choice(.auto, "native_ios_epic_auto")
            choice(.attended, "native_ios_epic_attended")
        }.background(SessionListStyle.background)
            .overlay { RoundedRectangle(cornerRadius: 2).stroke(SessionListStyle.brightLine, lineWidth: 1) }
    }
    private func choice(_ value: Components.Schemas.EpicRunPatch.ModePayload, _ key: StaticString) -> some View {
        Button { mode = value } label: {
            Text(verbatim: L.t(key)).sessionFont(label: true, weight: .medium)
                .frame(maxWidth: .infinity, minHeight: 44)
                .foregroundStyle(mode == value ? SessionListStyle.amber : SessionListStyle.muted)
                .background(mode == value ? SessionListStyle.amber.opacity(0.08) : .clear)
                .contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityAddTraits(mode == value ? [.isSelected] : [])
    }
}

struct IOSEpicSettingsSheet: View {
    let control: IOSEpicControl
    let epic: Epic
    @State private var starting: Bool
    @State private var values: IOSEpicSettings
    @Environment(\.dismiss) private var dismiss
    init(control: IOSEpicControl, epic: Epic) {
        self.control = control; self.epic = epic; _starting = State(initialValue: epic.run.status.rawValue == "idle"); _values = State(initialValue: .init(epic.run, defaultProvider: control.owner.store?.settings?.defaultAgentProvider ?? .claude))
    }
    var body: some View {
        NavigationStack {
            ScrollView {
                IOSEpicSettingsContent(values: $values, start: starting,
                    running: epic.run.status.rawValue == "running", busy: control.busy, writable: control.writable,
                    fableAvailable: ComposeRunConfig.defaults(from: control.owner.store?.settings).fableAvailable,
                    error: control.error, save: {
                        Task {
                            await control.update(values.patch(start: starting, running: epic.run.status.rawValue == "running"))
                            if control.error == nil, control.leader == nil, control.current { dismiss() }
                        }
                    })
            }.background(SessionListStyle.background)
                .navigationTitle(L.t("native_ios_epic_settings"))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button(L.t("common_close")) { dismiss() } } }
        }.presentationDetents([.large]).preferredColorScheme(.dark).tint(SessionListStyle.amber)
            .modifier(IOSEpicConfirmation(control: control))
            .onDisappear { control.cancelStart() }
            .onChange(of: control.digest?.epic.run.status.rawValue) { _, value in
                if value == "running", starting, control.error == nil { dismiss() }
            }
    }
}

struct IOSEpicSettingsContent: View {
    @Binding var values: IOSEpicSettings
    let start: Bool
    let running: Bool
    var busy = false
    var writable = true
    var fableAvailable = true
    var error: String?
    var save: () -> Void = {}
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(verbatim: L.t(start ? "native_ios_epic_start" : "native_ios_epic_settings"))
                .sessionFont(weight: .semibold).foregroundStyle(SessionListStyle.bright)
            VStack(alignment: .leading, spacing: 10) {
                IOSEpicModePicker(mode: $values.mode)
                Text(verbatim: L.t(values.mode == .auto ? "native_ios_epic_auto_hint" : "native_ios_epic_attended_hint"))
                    .sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
            }
            VStack(spacing: 0) {
                menu("epic_provider_label", value: L.t(values.provider == .claude ? "agent_provider_claude" : "agent_provider_codex"), selection: $values.provider) {
                    Text(verbatim: L.t("agent_provider_claude")).tag(AgentProvider.claude)
                    Text(verbatim: L.t("agent_provider_codex")).tag(AgentProvider.codex)
                }
                menu("epic_model_label", value: ModelGuidance.optionLabel(provider: values.provider, model: values.model).components(separatedBy: " · ")[0], selection: $values.model) {
                    ForEach(["default"] + ComposeRunConfig.providerModels(values.provider).filter {
                        ComposeRunConfig.available($0, provider: values.provider, fableAvailable: fableAvailable)
                    }, id: \.self) { value in
                        Text(verbatim: ModelGuidance.optionLabel(provider: values.provider, model: value)).tag(value)
                    }
                }
                menu("epic_effort_label", value: Self.effort(values.effort), selection: $values.effort) {
                    ForEach(["default"] + ComposeRunConfig.providerEfforts(values.provider, model: values.model), id: \.self) { value in
                        Text(verbatim: Self.effort(value)).tag(value)
                    }
                }
            }.background(SessionListStyle.panel)
                .overlay { Rectangle().stroke(SessionListStyle.line, lineWidth: 1) }
            Toggle(L.t("native_ios_epic_ignore_ceiling"), isOn: $values.ignoreUsageCeiling)
                .sessionFont(label: true).tint(SessionListStyle.amber).disabled(!start && !running)
            if let error { Text(verbatim: error).sessionFont(label: true).foregroundStyle(SessionListStyle.red) }
            IOSEpicActionButton(title: L.t(start ? "native_ios_epic_start" : "common_save"), icon: start ? "play" : "checkmark", action: save)
            if busy { ProgressView(L.t("common_loading")) }
        }.padding(16).foregroundStyle(SessionListStyle.ink).disabled(busy || !writable)
            .onChange(of: values.provider) { _, _ in values.normalize(fableAvailable: fableAvailable) }
            .onChange(of: values.model) { _, _ in values.normalize(fableAvailable: fableAvailable) }
    }
    private func menu<Value: Hashable, Content: View>(_ key: StaticString, value: String,
        selection: Binding<Value>, @ViewBuilder content: () -> Content) -> some View {
        Menu {
            Picker(selection: selection) { content() } label: { Text(verbatim: L.t(key)) }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(verbatim: L.t(key)).foregroundStyle(SessionListStyle.muted)
                Spacer(minLength: 0)
                Text(verbatim: value).multilineTextAlignment(.trailing).foregroundStyle(SessionListStyle.ink)
                Image(systemName: "chevron.right").foregroundStyle(SessionListStyle.muted)
            }.sessionFont(label: true).padding(.horizontal, 12).padding(.vertical, 10)
                .frame(maxWidth: .infinity, minHeight: 52).contentShape(Rectangle())
        }.buttonStyle(.plain)
    }
    static func effort(_ value: String) -> String {
        switch value {
        case "low": L.t("effort_label_low")
        case "medium": L.t("effort_label_medium")
        case "high": L.t("effort_label_high")
        case "xhigh": L.t("effort_label_xhigh")
        case "max": L.t("effort_label_max")
        case "ultra": L.t("effort_label_ultra")
        default: L.t("effort_default")
        }
    }
}
