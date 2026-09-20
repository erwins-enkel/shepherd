import ShepherdKit
import SwiftUI

struct EnginePicker: View {
    @Bindable var model: ComposeModel

    var selection: Binding<AgentProvider> {
        Binding(get: { model.provider }, set: { provider in
            guard model.allowsProvider(provider) else { return }
            model.provider = provider
        })
    }

    static func name(_ provider: AgentProvider) -> String {
        provider == .claude ? L.t("agent_provider_claude") : L.t("agent_provider_codex")
    }

    var body: some View {
        Picker(L.t("newtask_agent_provider_label"), selection: selection) {
            Text(verbatim: Self.name(.claude))
                .tag(AgentProvider.claude)
                .disabled(!model.allowsProvider(.claude))
            Text(verbatim: "\(Self.name(.codex)) · \(L.t("newtask_agent_provider_codex_alpha_badge"))")
                .tag(AgentProvider.codex)
                .disabled(!model.allowsProvider(.codex))
        }
        .pickerStyle(.menu)
        .accessibilityIdentifier("compose.engine")
    }
}
