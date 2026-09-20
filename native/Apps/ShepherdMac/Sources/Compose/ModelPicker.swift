import Foundation
import ShepherdKit
import SwiftUI

/// Model validity and preselection from new-task/run-config.ts. No view lifecycle dependency.
enum ComposeRunConfig {
    struct Defaults {
        var provider: AgentProvider = .claude
        var claudeModel = "auto"
        var codexModel = "auto"
        var effort = "default"
        var fableAvailable = true
        func model(for provider: AgentProvider) -> String { provider == .codex ? codexModel : claudeModel }
    }
    struct Selection {
        var provider: AgentProvider
        var model: String
        var effort: String
    }

    static let claudeModels = ["fable", "claude-fable-5-1", "opus", "opus[1m]", "claude-opus-5",
                               "claude-opus-5[1m]", "sonnet", "sonnet[1m]", "haiku"]
    static let codexModels = ["gpt-5.6-sol", "gpt-6-astra", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4",
                              "gpt-5.3-codex", "gpt-5.1-codex", "gpt-5-codex", "gpt-5.1", "gpt-5", "o3"]
    static let efforts = ["low", "medium", "high", "xhigh", "max", "ultra"]

    static func providerModels(_ provider: AgentProvider) -> [String] {
        provider == .codex ? codexModels : claudeModels
    }

    static func providerEfforts(_ provider: AgentProvider, model: String) -> [String] {
        if provider == .claude || model == "gpt-5.6-luna" { return Array(efforts.prefix(5)) }
        if ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra"].contains(model) { return efforts }
        if codexModels.contains(model) { return Array(efforts.prefix(4)) }
        return efforts
    }

    static func isFable(_ model: String) -> Bool { model == "fable" || model.hasPrefix("claude-fable-") }

    static func available(_ model: String, provider: AgentProvider, fableAvailable: Bool) -> Bool {
        if model == "default" { return true }
        if provider == .claude && isFable(model) && !fableAvailable { return false }
        return providerModels(provider).contains(model)
    }

    static func preselectModel(_ configured: String?, provider: AgentProvider,
                               fableAvailable: Bool, now: Date = .now) -> String {
        let pick: String
        if let configured, !configured.isEmpty, configured != "auto" { pick = configured }
        else {
            // ui/src/lib/fable-promo.ts: inclusive 2026-06-22 23:59:59 Europe/Berlin.
            pick = provider == .claude && now.timeIntervalSince1970 <= 1_782_165_599 ? "fable" : "default"
        }
        return isFable(pick) && !fableAvailable ? "default" : pick
    }

    static func preselectEffort(_ setting: String?) -> String {
        guard let setting, !setting.isEmpty, setting != "default", setting != "inherit" else { return "default" }
        return setting
    }

    static func modelForManualProviderChange(_ provider: AgentProvider, defaults: Defaults) -> String {
        let fallback = preselectModel(defaults.model(for: provider), provider: provider,
                                      fableAvailable: defaults.fableAvailable)
        return available(fallback, provider: provider, fableAvailable: defaults.fableAvailable) ? fallback : "default"
    }

    static func normalizeRunConfig(provider: AgentProvider, model: String, effort: String,
                                   defaults: Defaults, constraint: AgentProvider?) -> Selection {
        let provider = constraint ?? provider
        let model = available(model, provider: provider, fableAvailable: defaults.fableAvailable)
            ? model : modelForManualProviderChange(provider, defaults: defaults)
        let effort = effort == "default" || providerEfforts(provider, model: model).contains(effort) ? effort : "default"
        return .init(provider: provider, model: model, effort: effort)
    }
}

/// The complete model · effort row and its cost/fit explanation. The sheet mounts this in Task 9.
struct ModelPicker: View {
    @Bindable var model: ComposeModel

    var options: [String] {
        ["default"] + ComposeRunConfig.providerModels(model.provider).filter {
            ComposeRunConfig.available($0, provider: model.provider, fableAvailable: model.runDefaults.fableAvailable)
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
                .accessibilityIdentifier("compose.model")
                EffortPicker(model: model)
            }
            ModelGuidanceView(guidance: .value(provider: model.provider, model: model.model))
        }
    }
}
