import Foundation
import Testing
import ShepherdKit
@testable import ShepherdAppCore

extension CoreSeamTests {
struct RepoSettingsFormTests {
    private func config(_ overrides: [String: Any] = [:]) throws -> RepoConfig {
        var json: [String: Any] = [
            "criticEnabled": false, "criticAllPrs": false, "criticSmellLensEnabled": false,
            "autoAddressEnabled": false, "autopilotEnabled": false, "planGateEnabled": false,
            "autoDrainEnabled": false, "autoMergeEnabled": false, "buildQueueEnabled": false,
            "draftMode": false, "manualStepsIssueEnabled": false, "preWarmEpicLandingCi": false,
            "mergeWithoutCi": false, "epicStacksEnabled": false, "sharedBrowserEnabled": false,
            "claudeAiConnectorsEnabled": false, "hidden": false, "pinned": false,
            "signoffAuthority": "either", "maxAuto": 1, "autoLabel": "shepherd", "usageCeilingPct": 90,
            "sandboxProfile": "inherit", "defaultModel": "inherit", "defaultEffort": "inherit",
            "egressExtraHosts": [String](), "browserAllowedHosts": [String](), "repoMode": "github",
            "previewOpenMode": "ask",
        ]
        json.merge(overrides) { $1 }
        return try JSONDecoder().decode(RepoConfig.self, from: JSONSerialization.data(withJSONObject: json))
    }

    private func encoded(_ patch: RepoConfigPatch) throws -> [String: Any] {
        try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(patch)) as? [String: Any])
    }

    @Test func mergeModeWritesBothFieldsSoDraftAndAutoMergeNeverCoexist() throws {
        for mode in RepoSettingsForm.MergeMode.allCases {
            let body = try encoded(RepoSettingsForm.mergePatch(mode))
            #expect(body.count == 2)
            #expect(body["draftMode"] as? Bool == (mode == .draft))
            #expect(body["autoMergeEnabled"] as? Bool == (mode == .auto))
            #expect(!((body["draftMode"] as? Bool ?? false) && (body["autoMergeEnabled"] as? Bool ?? false)))
        }
        #expect(RepoSettingsForm.mergeMode(draftMode: true, autoMergeEnabled: true) == .draft)
        #expect(RepoSettingsForm.mergeMode(draftMode: false, autoMergeEnabled: true) == .auto)
        #expect(RepoSettingsForm.mergeMode(draftMode: false, autoMergeEnabled: false) == .manual)
        #expect(RepoSettingsForm.effectiveMergeMode(try config(["draftMode": true, "repoMode": "lightweight"])) == .manual)
        #expect(RepoSettingsForm.effectiveMergeMode(try config(["autoMergeEnabled": true, "repoMode": "lightweight"])) == .auto)
    }

    @Test func autonomyPresetsWriteExactlySixFieldsAndRoundTrip() throws {
        let expectedKeys: Set<String> = ["criticEnabled", "autoAddressEnabled", "autopilotEnabled",
                                          "autoDrainEnabled", "autoMergeEnabled", "draftMode"]
        for level in RepoSettingsForm.AutonomyLevel.allCases {
            let patch = try encoded(RepoSettingsForm.autonomyPatch(level))
            #expect(Set(patch.keys) == expectedKeys)
            #expect(patch["criticEnabled"] as? Bool == (level != .onCall))
            #expect(patch["autoAddressEnabled"] as? Bool == (level != .onCall))
            #expect(patch["autopilotEnabled"] as? Bool == (level != .onCall))
            #expect(patch["autoDrainEnabled"] as? Bool == (level == .backlog || level == .full))
            #expect(patch["autoMergeEnabled"] as? Bool == (level == .full))
            #expect(patch["draftMode"] as? Bool == false)
            var values = patch
            values["planGateEnabled"] = true
            values["sandboxProfile"] = "standard"
            let result = try config(values)
            #expect(RepoSettingsForm.autonomyLevel(result) == level)
            #expect(result.planGateEnabled && result.sandboxProfile == "standard")
        }
    }

    @Test func autonomyReadsEffectiveValuesAndCustomMixes() throws {
        #expect(RepoSettingsForm.autonomyLevel(try config(["autoAddressEnabled": true])) == .onCall)
        var review = try encoded(RepoSettingsForm.autonomyPatch(.review))
        review["draftMode"] = true
        #expect(RepoSettingsForm.autonomyLevel(try config(review)) == nil)
        review["repoMode"] = "lightweight"
        #expect(RepoSettingsForm.autonomyLevel(try config(review)) == .review)
        var backlog = try encoded(RepoSettingsForm.autonomyPatch(.backlog))
        backlog["repoMode"] = "lightweight"
        #expect(RepoSettingsForm.autonomyLevel(try config(backlog)) == .review)
        backlog["autoMergeEnabled"] = true
        #expect(RepoSettingsForm.autonomyLevel(try config(backlog)) == nil)
        #expect(RepoSettingsForm.AutonomyLevel.allCases.filter(\.needsForge) == [.backlog, .full])
    }

    @Test func autonomyResponsibilitiesFollowTheConfigIncludingPlanGate() throws {
        for level in RepoSettingsForm.AutonomyLevel.allCases {
            let value = try config(encoded(RepoSettingsForm.autonomyPatch(level)))
            #expect(!RepoSettingsForm.shepherdHandles(.plan, config: value))
            #expect(RepoSettingsForm.shepherdHandles(.pickup, config: value) == level.needsForge)
            #expect(RepoSettingsForm.shepherdHandles(.stops, config: value) == (level != .onCall))
            #expect(RepoSettingsForm.shepherdHandles(.review, config: value) == (level != .onCall))
            #expect(RepoSettingsForm.shepherdHandles(.fix, config: value) == (level != .onCall))
            #expect(RepoSettingsForm.shepherdHandles(.merge, config: value) == (level == .full))
        }
        let value = try config(["planGateEnabled": true, "autoAddressEnabled": true,
                                "autoDrainEnabled": true, "repoMode": "lightweight", "draftMode": true])
        #expect(RepoSettingsForm.shepherdHandles(.plan, config: value))
        #expect(!RepoSettingsForm.shepherdHandles(.fix, config: value))
        #expect(!RepoSettingsForm.shepherdHandles(.pickup, config: value))
        #expect(!RepoSettingsForm.shepherdHandles(.merge, config: value))
    }

    @Test func modelAndEffortFollowTheEffectiveCli() throws {
        let inherits = try config()
        #expect(RepoSettingsForm.effectiveProvider(inherits, global: .codex) == .codex)
        let pinned = try config(["agentProvider": "claude", "defaultModel": "gpt-6.1-sol", "defaultEffort": "ultra"])
        let cli = RepoSettingsForm.effectiveProvider(pinned, global: .codex)
        #expect(cli == .claude)
        #expect(RepoSettingsForm.shownModel(pinned.defaultModel, provider: cli) == "inherit")
        #expect(RepoSettingsForm.shownEffort(pinned.defaultEffort, provider: cli) == "inherit")
        #expect(RepoSettingsForm.shownModel("gpt-6.1-sol", provider: .codex) == "gpt-6.1-sol")
        #expect(RepoSettingsForm.shownEffort("ultra", provider: .codex) == "ultra")
        let claudeModels = RepoSettingsForm.modelOptions(shown: "inherit", provider: .claude,
                                                         fableAvailable: true, mythosAvailable: false)
        #expect(Array(claudeModels.prefix(3)) == ["inherit", "auto", "default"])
        #expect(claudeModels.contains("opus") && !claudeModels.contains("gpt-6.1-sol"))
        #expect(!RepoSettingsForm.effortOptions(provider: .claude).contains("ultra"))
        #expect(RepoSettingsForm.effortOptions(provider: .codex).contains("ultra"))
        #expect(RepoSettingsForm.providerOptions == ["inherit", "claude", "codex"])
    }

    @Test func extraHostsShowOnlyUnderAnAutonomousSandbox() throws {
        #expect(RepoSettingsForm.showsEgressHosts(try config(["sandboxProfile": "autonomous"])))
        #expect(!RepoSettingsForm.showsEgressHosts(try config(["sandboxProfile": "standard"])))
        #expect(RepoSettingsForm.showsEgressHosts(try config(["sandboxDefaultProfile": "autonomous"])))
        #expect(!RepoSettingsForm.showsEgressHosts(try config()))
        #expect(RepoSettingsForm.shownSandbox(try config(["sandboxProfile": "bogus"])) == "inherit")
    }

    @Test func egressHostCheckMirrorsTheWeb() {
        #expect(RepoSettingsForm.checkEgressHost("  Registry.Example.com ", existing: []) == .success("registry.example.com"))
        #expect(RepoSettingsForm.checkEgressHost("   ", existing: []) == .failure(.empty))
        #expect(RepoSettingsForm.checkEgressHost("localhost", existing: []) == .failure(.invalid))
        #expect(RepoSettingsForm.checkEgressHost("https://a.example.com", existing: []) == .failure(.invalid))
        #expect(RepoSettingsForm.checkEgressHost("a.example.com", existing: ["a.example.com"]) == .failure(.duplicate))
        #expect(RepoSettingsForm.checkEgressHost("a.example.com:443", existing: ["a.example.com"]) == .failure(.duplicate))
        let accepted = [
            ("*.Example.com", "*.example.com"),
            ("git.example.com:8443", "git.example.com:8443"),
            ("*.example.com:22", "*.example.com:22"),
            ("x.com:443", "x.com"),
            ("*.x.com:443", "*.x.com"),
            ("x.com:65535", "x.com:65535"),
            ("10.0.0.1", "10.0.0.1"),
        ]
        for (raw, value) in accepted {
            #expect(RepoSettingsForm.checkEgressHost(raw, existing: []) == .success(value))
        }
        let rejected = [
            "*.com", "*x.com", "a.*.com", "*.*.x.com", "*.1.2.3.4",
            "x.com:", "x.com:0", "x.com:0443", "x.com:65536", "x.com:22:23", "x.com/a",
        ]
        for raw in rejected {
            #expect(RepoSettingsForm.checkEgressHost(raw, existing: []) == .failure(.invalid))
        }
        #expect(RepoSettingsForm.isWildcardEgressEntry("*.example.com:22"))
        #expect(!RepoSettingsForm.isWildcardEgressEntry("example.com"))
    }
}
}
