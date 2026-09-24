import Foundation
import ShepherdKit
import Testing
@testable import ShepherdAppCore

extension CoreSeamTests {
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
        .init(provider: .codex, model: "gpt-6-sol", cost: "high", tag: "strong", detail: "codex_6_sol"),
        .init(provider: .codex, model: "gpt-6-luna", cost: "low", tag: "budget", detail: "codex_6_luna"),
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

    @Test(arguments: rows)
    func everyGuidanceRowMatchesTheWeb(_ expected: Expected) {
        let g = ModelGuidance.value(provider: expected.provider, model: expected.model)
        #expect(g.costTier.rawValue == expected.cost)
        #expect(g.tag.rawValue == expected.tag)
        #expect(String(describing: g.detailKey) == "model_guidance_" + expected.detail)
        #expect(g.costMark == ["low": "$", "standard": "$$", "high": "$$$", "premium": "$$$$"][expected.cost])
        #expect(g.detail == L.t(g.detailKey))
    }

    @Test func listsAndUnknownFallbackAreExact() {
        #expect(Self.rows.count == 26)
        #expect(ComposeRunConfig.claudeModels == ["fable", "claude-fable-5-1", "opus", "opus[1m]",
            "claude-opus-5", "claude-opus-5[1m]", "sonnet", "sonnet[1m]", "haiku"])
        #expect(ComposeRunConfig.codexModels == ["gpt-5.6-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-terra", "gpt-5.6-luna",
            "gpt-5.5", "gpt-5.4", "gpt-5.3-codex", "gpt-5.1-codex", "gpt-5-codex", "gpt-5.1", "gpt-5", "o3"])
        for provider in [AgentProvider.claude, .codex] {
            for model in ["unknown", provider == .claude ? "gpt-6-astra" : "opus"] {
                let g = ModelGuidance.value(provider: provider, model: model)
                #expect(g.costTier == .standard && g.tag == .balanced)
                #expect(g.detail == L.t("model_guidance_unknown"))
            }
            for model in ["auto", "default", "inherit"] {
                #expect(ModelGuidance.value(provider: provider, model: model).tag == .providerDefault)
            }
        }
    }

    @Test func configuredLabelsBadgesAndProseUseTheExistingCopy() {
        let g = ModelGuidance.value(provider: .codex, model: "gpt-6-astra")
        #expect(g.costBadge == L.t("model_cost_premium").uppercased())
        #expect(g.tagBadge == L.t("model_tag_max").uppercased())
        #expect(g.detail == L.t("model_guidance_codex_6_astra"))
        #expect(ModelGuidance.optionLabel(provider: .codex, model: "gpt-6-astra") == "gpt-6-astra · \(L.t("model_tag_max")) · $$$$")
        #expect(ModelGuidance.configuredModelLabel("opus") == L.t("model_configured_opus_latest"))
        #expect(ModelGuidance.configuredModelLabel("opus[1m]") == L.t("model_configured_opus_1m_latest"))
        #expect(ModelGuidance.configuredModelLabel("claude-opus-5") == L.t("model_label_opus_5"))
        #expect(ModelGuidance.configuredModelLabel("fable") == L.t("model_configured_fable_latest"))
        #expect(ModelGuidance.configuredModelLabel("claude-fable-5-1") == L.t("model_label_fable_5_1"))
        #expect(ModelGuidance.configuredModelLabel("claude-opus-5[1m]") == L.t("model_label_opus_5_1m"))
        #expect(ModelGuidance.configuredModelLabel("sonnet[1m]") == L.t("model_label_sonnet_1m"))
    }

    @Test func preselectionPortsThePromoCutoffAndFableAvailability() {
        let cutoff = ISO8601DateFormatter().date(from: "2026-06-22T23:59:59+02:00")!
        #expect(ComposeRunConfig.preselectModel(nil, provider: .claude, fableAvailable: true, now: cutoff) == "fable")
        #expect(ComposeRunConfig.preselectModel("auto", provider: .claude, fableAvailable: true,
                                               now: cutoff.addingTimeInterval(1)) == "default")
        #expect(ComposeRunConfig.preselectModel("auto", provider: .codex, fableAvailable: true, now: cutoff) == "default")
        for model in ["fable", "claude-fable-5-1"] {
            #expect(ComposeRunConfig.preselectModel(model, provider: .claude, fableAvailable: false) == "default")
            #expect(ComposeRunConfig.preselectModel(model, provider: .claude, fableAvailable: true) == model)
        }
        for effort in [nil, "", "default", "inherit"] {
            #expect(ComposeRunConfig.preselectEffort(effort) == "default")
        }
        #expect(ComposeRunConfig.preselectEffort("high") == "high")
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

    @Test func missingCodexSettingMatchesWebFallbackAndCost() throws {
        let model = seededComposer(.init(provider: .codex))
        defer { model.teardown() }
        model.repoPath = "/repo"; model.prompt = "Do work"
        #expect(model.model == "gpt-5.6-sol")
        #expect(try #require(model.createRequest(baseBranch: "main")).model == "gpt-5.6-sol")
        #expect(ModelGuidance.value(provider: model.provider, model: model.model).costTier == .premium)
        model.selectProviderManually(.claude)
        model.selectProviderManually(.codex)
        #expect(model.model == "gpt-5.6-sol")
    }

    @Test func explicitCodexAutoStillSubmitsTheProviderDefault() throws {
        let model = seededComposer(.init(provider: .codex, codexModel: "auto"))
        defer { model.teardown() }
        model.repoPath = "/repo"; model.prompt = "Do work"
        #expect(model.model == "default")
        #expect(try #require(model.createRequest(baseBranch: "main")).model == nil)
        #expect(ModelGuidance.value(provider: model.provider, model: model.model).costTier == .standard)
    }

    @Test(arguments: ["fable", "claude-fable-5-1"])
    func unavailableInitialFablePrecedesConfiguredClaudeDefault(_ initial: String) throws {
        let model = seededComposer(.init(claudeModel: "opus", fableAvailable: false), initial: initial)
        defer { model.teardown() }
        model.repoPath = "/repo"; model.prompt = "Do work"
        #expect(model.model == "default")
        #expect(try #require(model.createRequest(baseBranch: "main")).model == nil)
        let available = seededComposer(.init(claudeModel: "opus"), initial: initial)
        defer { available.teardown() }
        #expect(available.model == initial)
        let absent = seededComposer(.init(claudeModel: "opus", fableAvailable: false))
        defer { absent.teardown() }
        #expect(absent.model == "opus")
    }

    @Test func initializationSeedsDefaultsAndCorrectsExplicitInvalidValues() throws {
        func make(_ initialModel: String? = nil, _ initialEffort: String? = nil) -> ComposeModel {
            ComposeModel(defaults: UserDefaults(suiteName: "ModelGuidanceTests.\(UUID())")!,
                         repoBranches: RepoBranchModel(loadBranches: { _ in .init(branches: []) },
                            loadStatus: { _, _ in .init(behind: 0, ahead: 0, diverged: false,
                                                       hasUpstream: false, localExists: false) },
                            repair: { _, branch in .init(branch: branch) }),
                         loadIssues: { _ in .init(issues: []) }, loadCommands: { _, _ in .init(commands: []) },
                         loadEpics: { _ in .init(epics: [], subIssues: []) },
                         runDefaults: .init(provider: .codex, codexModel: "gpt-6-astra", effort: "ultra"),
                         initialModel: initialModel, initialEffort: initialEffort)
        }
        let seeded = make()
        defer { seeded.teardown() }
        #expect(seeded.provider == .codex && seeded.model == "gpt-6-astra" && seeded.effort == "ultra")
        seeded.repoPath = "/repo"; seeded.prompt = "Do work"
        let request = try #require(seeded.createRequest(baseBranch: "main"))
        #expect(request.model == "gpt-6-astra" && request.effort?.rawValue == "ultra")
        let pinned = make("gpt-5.6-luna", "ultra")
        defer { pinned.teardown() }
        #expect(pinned.model == "gpt-5.6-luna" && pinned.effort == "default")
        let invalid = make("opus", "invalid")
        defer { invalid.teardown() }
        #expect(invalid.model == "gpt-6-astra" && invalid.effort == "default")
    }

    @Test func constraintNormalizesAgainstTheCorrectedModelsEfforts() {
        let result = ComposeRunConfig.normalizeRunConfig(provider: .claude, model: "opus", effort: "ultra",
            defaults: .init(codexModel: "gpt-6-astra"), constraint: .codex)
        #expect(result.provider == .codex && result.model == "gpt-6-astra" && result.effort == "ultra")
        for model in ["gpt-6-sol", "gpt-6-luna"] {
            let normalized = ComposeRunConfig.normalizeRunConfig(provider: .codex, model: model, effort: "max",
                defaults: .init(codexModel: model), constraint: nil)
            #expect(normalized.model == model && normalized.effort == "max")
            let ultra = ComposeRunConfig.normalizeRunConfig(provider: .codex, model: model, effort: "ultra",
                defaults: .init(codexModel: model), constraint: nil)
            #expect(ultra.effort == (model == "gpt-6-sol" ? "ultra" : "default"))
        }
    }

    @Test func germanBadgesAndAllEffortLabelsMatchTheBrief() throws {
        let path = try #require(CoreResources.bundle.path(forResource: "de", ofType: "lproj"))
        let bundle = try #require(Bundle(path: path))
        func german(_ key: String) -> String { bundle.localizedString(forKey: key, value: nil, table: "Localizable") }
        #expect(german("model_cost_premium").uppercased() == "PREMIUM-KOSTEN")
        #expect(german("model_tag_max").uppercased() == "MAXIMAL")
        let keys = ["effort_default", "effort_label_low", "effort_label_medium", "effort_label_high",
                    "effort_label_xhigh", "effort_label_max", "effort_label_ultra"]
        #expect(keys.map(german) == ["Standard", "Niedrig", "Mittel", "Hoch", "Sehr hoch", "Maximal", "Ultra"])
    }

    @Test func neverOpenedPickersStillSubmitNormalizedValues() throws {
        let m = ComposeModelTests.composer()
        defer { m.teardown() }
        m.repoPath = "/repo"; m.prompt = "Do work"
        m.runDefaults = .init(claudeModel: "opus", codexModel: "gpt-5.5")
        m.provider = .codex; m.model = "opus"; m.effort = "max"
        let request = try #require(m.createRequest(baseBranch: "main"))
        #expect(request.agentProvider == .codex)
        #expect(request.model == "gpt-5.5" && request.effort == nil)
        m.model = "gpt-6-astra"; m.effort = "ultra"
        #expect(m.createRequest(baseBranch: "main")?.effort?.rawValue == "ultra")
        m.model = "gpt-5.6-luna"
        #expect(m.effort == "default")
        m.effort = "max"
        #expect(m.createRequest(baseBranch: "main")?.effort?.rawValue == "max")
        m.runDefaults.codexModel = "invalid"
        m.model = "invalid"
        #expect(m.createRequest(baseBranch: "main")?.model == nil)
    }

    @Test func unavailableFableAndCommandConstraintsNormalizeInTheModel() throws {
        let m = ComposeModelTests.composer()
        defer { m.teardown() }
        m.repoPath = "/repo"; m.prompt = "Do work"
        m.runDefaults = .init(claudeModel: "fable", codexModel: "gpt-6-astra")
        m.model = "claude-fable-5-1"
        m.runDefaults.fableAvailable = false
        #expect(m.model == "default")
        m.pickCommand(.init(name: "ship", description: "Ship", scope: .init(known: .project), providers: [.codex]))
        m.provider = .claude
        let request = try #require(m.createRequest(baseBranch: "main"))
        #expect(request.agentProvider == .codex)
        #expect(m.provider == .codex)
        m.pickCommand(.init(name: "plan", description: "Plan", scope: .init(known: .project), providers: [.claude]))
        #expect(m.provider == .claude)
    }

}
}
