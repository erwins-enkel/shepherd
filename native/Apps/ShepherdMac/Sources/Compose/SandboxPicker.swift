import ShepherdKit
import SwiftUI

/// Task 9 supplies the live hold advisory; this view does not depend on the capacity meter.
struct SandboxPicker: View {
    @Bindable var model: ComposeModel
    let holdLikely: Bool

    var selection: Binding<Components.Schemas.SandboxProfile?> {
        Binding(get: { model.sandboxProfile }, set: { profile in
            guard !(model.sandboxLocked && profile == .autonomous) else { return }
            model.sandboxProfile = profile
        })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker(L.t("newtask_sandbox_label"), selection: selection) {
                Text(verbatim: L.t("newtask_sandbox_default"))
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
            Text(verbatim: L.t("newtask_sandbox_hint"))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if model.research {
                Text(verbatim: L.t("newtask_research_sandbox_note"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("compose.researchSandboxNote")
            }
            CodexAlphaWarning(provider: model.provider, holdLikely: holdLikely)
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
