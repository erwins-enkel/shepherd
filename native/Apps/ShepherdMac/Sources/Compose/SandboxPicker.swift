import ShepherdAppCore
import ShepherdKit
import SwiftUI

/// Per-task sandbox override; the full explanation lives in hover help.
struct SandboxPicker: View {
    @Bindable var model: ComposeModel

    var selection: Binding<Components.Schemas.SandboxProfile?> {
        Binding(get: { model.sandboxProfile }, set: { profile in
            guard !(model.sandboxLocked && profile == .autonomous) else { return }
            model.sandboxProfile = profile
        })
    }

    static func name(_ profile: Components.Schemas.SandboxProfile) -> String {
        switch profile {
        case .trusted: L.t("sandbox_profile_trusted")
        case .standard: L.t("sandbox_profile_standard")
        case .autonomous: L.t("sandbox_profile_autonomous")
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: L.t("newtask_sandbox_label")).font(.caption).foregroundStyle(.secondary)
            Picker(L.t("newtask_sandbox_label"), selection: selection) {
                Text(verbatim: model.inheritedSandboxProfile.map { L.t("native_compose_sandbox_default_resolved", Self.name($0)) }
                    ?? L.t("newtask_sandbox_default"))
                    .tag(Optional<Components.Schemas.SandboxProfile>.none)
                Text(verbatim: L.t("sandbox_profile_trusted"))
                    .tag(Optional(Components.Schemas.SandboxProfile.trusted))
                Text(verbatim: L.t("sandbox_profile_standard"))
                    .tag(Optional(Components.Schemas.SandboxProfile.standard))
                Text(verbatim: L.t("sandbox_profile_autonomous"))
                    .tag(Optional(Components.Schemas.SandboxProfile.autonomous))
                    .disabled(model.sandboxLocked)
            }
            .accessibilityIdentifier("compose.sandbox")
            .pickerStyle(.menu).labelsHidden()
            .help(L.t("newtask_sandbox_hint"))
        }
    }
}

struct CodexAlphaWarning: View {
    let provider: AgentProvider
    let holdLikely: Bool

    var paragraphs: [String] {
        guard provider == .codex else { return [] }
        var result = [L.t("newtask_agent_provider_codex_alpha_note")]
        if holdLikely { result.append(L.t("newtask_agent_provider_codex_suggested_for_hold")) }
        result.append(L.t("newtask_agent_provider_codex_note"))
        return result
    }

    var body: some View {
        if provider == .codex {
            VStack(alignment: .leading, spacing: 8) {
                Text(verbatim: "⚠ \(L.t("newtask_alpha_caution"))")
                    .fixedSize(horizontal: false, vertical: true)
                DisclosureGroup(L.t("newtask_alpha_details")) {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(paragraphs, id: \.self) { paragraph in
                            Text(verbatim: paragraph)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            }
            .accessibilityIdentifier("compose.codexAlpha")
        }
    }
}
