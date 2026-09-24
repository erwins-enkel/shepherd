import Foundation
import ShepherdKit
import Testing
@testable import Shepherd
@testable import ShepherdAppCore

extension MacSeamTests {
@MainActor @Suite struct ModelGuidanceTests {
    struct Expected: Sendable {
        let provider: AgentProvider
        let model: String
        let cost: String
        let tag: String
        let detail: String
    }

    nonisolated static let rows: [Expected] = [
        .init(provider: .claude, model: "auto", cost: "standard", tag: "providerDefault", detail: "auto"),
        .init(provider: .claude, model: "default", cost: "standard", tag: "providerDefault", detail: "default"),
        .init(provider: .codex, model: "inherit", cost: "standard", tag: "providerDefault", detail: "inherit"),
        .init(provider: .claude, model: "fable", cost: "premium", tag: "max", detail: "claude_fable"),
        .init(provider: .claude, model: "claude-fable-5-1", cost: "premium", tag: "max", detail: "claude_fable_5_1"),
        .init(provider: .claude, model: "opus", cost: "high", tag: "strong", detail: "claude_opus"),
        .init(provider: .claude, model: "opus[1m]", cost: "premium", tag: "longContext", detail: "claude_opus_1m"),
        .init(provider: .claude, model: "claude-opus-5", cost: "high", tag: "strong", detail: "claude_opus_5"),
        .init(provider: .claude, model: "claude-opus-5[1m]", cost: "premium", tag: "longContext", detail: "claude_opus_5_1m"),
        .init(provider: .claude, model: "sonnet", cost: "standard", tag: "balanced", detail: "claude_sonnet"),
        .init(provider: .claude, model: "sonnet[1m]", cost: "high", tag: "longContext", detail: "claude_sonnet_1m"),
        .init(provider: .claude, model: "haiku", cost: "low", tag: "budget", detail: "claude_haiku"),
        .init(provider: .codex, model: "gpt-6-astra", cost: "premium", tag: "max", detail: "codex_6_astra"),
        .init(provider: .codex, model: "gpt-5.5", cost: "premium", tag: "max", detail: "codex_55"),
        .init(provider: .codex, model: "gpt-5.6-sol", cost: "premium", tag: "max", detail: "codex_56_sol"),
        .init(provider: .codex, model: "gpt-5.6-terra", cost: "high", tag: "balanced", detail: "codex_56_terra"),
        .init(provider: .codex, model: "gpt-5.6-luna", cost: "low", tag: "budget", detail: "codex_56_luna"),
        .init(provider: .codex, model: "gpt-5.4", cost: "high", tag: "strong", detail: "codex_54"),
        .init(provider: .codex, model: "gpt-5.3-codex", cost: "standard", tag: "balanced", detail: "codex_53"),
        .init(provider: .codex, model: "gpt-5.1-codex", cost: "standard", tag: "balanced", detail: "codex_51_codex"),
        .init(provider: .codex, model: "gpt-5-codex", cost: "low", tag: "budget", detail: "codex_5_codex"),
        .init(provider: .codex, model: "gpt-5.1", cost: "standard", tag: "balanced", detail: "codex_51"),
        .init(provider: .codex, model: "gpt-5", cost: "low", tag: "budget", detail: "codex_5"),
        .init(provider: .codex, model: "o3", cost: "high", tag: "strong", detail: "codex_o3")
    ]

    @Test func effortMatrixMatchesEveryCuratedModelAndTheFallback() {
        let all = ["low", "medium", "high", "xhigh", "max", "ultra"]
        for model in ComposeRunConfig.claudeModels + ["default", "unknown"] {
            #expect(ComposeRunConfig.providerEfforts(.claude, model: model) == Array(all.prefix(5)))
        }
        for model in ComposeRunConfig.codexModels + ["default", "unknown"] {
            let count = ["gpt-6-astra", "gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-terra", "default", "unknown"].contains(model)
                ? 6 : ["gpt-6-luna", "gpt-5.6-luna"].contains(model) ? 5 : 4
            #expect(ComposeRunConfig.providerEfforts(.codex, model: model) == Array(all.prefix(count)))
        }
        #expect(EffortPicker.label("max") == L.t("effort_label_max"))
        #expect(EffortPicker.label("default") == L.t("effort_default"))
    }

    private func seededComposer(_ defaults: ComposeRunConfig.Defaults, initial: String? = nil) -> ComposeModel {
        ComposeModel(defaults: UserDefaults(suiteName: "ModelGuidanceTests.\(UUID())")!,
                     repoBranches: RepoBranchModel(loadBranches: { _ in .init(branches: []) },
                        loadStatus: { _, _ in .init(behind: 0, ahead: 0, diverged: false,
                                                   hasUpstream: false, localExists: false) },
                        repair: { _, branch in .init(branch: branch) }),
                     loadIssues: { _ in .init(issues: []) }, loadCommands: { _, _ in .init(commands: []) },
                     loadEpics: { _ in .init(epics: [], subIssues: []) },
                     runDefaults: defaults, initialModel: initial)
    }

    @Test func pickerOptionsReflectAvailabilityAndLeadWithDefault() {
        let m = ComposeModelTests.composer()
        defer { m.teardown() }
        m.runDefaults.fableAvailable = false
        #expect(ModelPicker(model: m).options == ["default"] + Array(ComposeRunConfig.claudeModels.dropFirst(2)))
        #expect(EffortPicker(model: m).options == ["default", "low", "medium", "high", "xhigh", "max"])
        m.provider = .codex; m.model = "gpt-6-astra"
        #expect(ModelPicker(model: m).options == ["default"] + ComposeRunConfig.codexModels)
        #expect(EffortPicker(model: m).options.last == "ultra")
    }

    @Test func manualEngineChangeResetsEvenAValidTouchedModel() {
        let m = ComposeModelTests.composer()
        defer { m.teardown() }
        m.runDefaults = .init(claudeModel: "opus", codexModel: "gpt-6-astra")
        m.provider = .codex; m.model = "gpt-5.6-sol"; m.effort = "ultra"
        EnginePicker(model: m).selection.wrappedValue = .codex
        #expect(m.model == "gpt-6-astra")
        EnginePicker(model: m).selection.wrappedValue = .claude
        #expect(m.model == "opus" && m.effort == "default")
        m.runDefaults.claudeModel = "gpt-6-astra"
        m.selectProviderManually(.claude)
        #expect(m.model == "default")
    }
}
}
