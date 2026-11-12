import Foundation
import Testing
import ShepherdKit
@testable import ShepherdAppCore

struct RepoRuleMergeTests {
    private func project() throws -> RepoConfigProject {
        var rules = try JSONSerialization.jsonObject(with: JSONEncoder().encode(RepoProjectDraftTests.rules)) as! [String: Any]
        rules["leitrechner"] = NSNull()
        rules["maxAuto"] = 9 // Unknown response properties must not become shared rules.
        // Config is decoded with the same complete shape as the server response.
        var config = rules
        config.merge(["fieldSources": [:], "repoConfigCommit": NSNull(), "mergeWithoutCi": false,
            "sharedBrowserEnabled": false, "claudeAiConnectorsEnabled": false, "hidden": false, "pinned": false,
            "maxAuto": 1, "usageCeilingPct": 90, "sandboxProfile": "inherit", "egressExtraHosts": [],
            "browserAllowedHosts": [], "repoMode": "github", "previewOpenMode": "ask"]) { $1 }
        config["autoDrainEnabled"] = true
        var other = config
        other["criticEnabled"] = true; other["defaultModel"] = "custom"; other["maxAuto"] = 8
        let json: [String: Any] = ["remoteSlug": "owner/app", "complete": true, "referenceInstanceId": "mac",
            "rules": rules.merging(["autoDrainEnabled": true]) { $1 }, "repoConfigCommit": NSNull(),
            "machines": [
                ["instanceId": "mac", "name": "Mac", "membership": "present", "reachable": true, "reason": NSNull(), "config": config],
                ["instanceId": "linux", "name": "Linux", "membership": "present", "reachable": true, "reason": NSNull(), "config": other]],
            "differences": ["applicable": true, "complete": true, "unavailableInstanceIds": [], "fields": [], "multipleAutoDrain": ["mac", "linux"]]]
        return try JSONDecoder().decode(RepoConfigProject.self, from: JSONSerialization.data(withJSONObject: json))
    }

    @Test func selectionsCreateOneFullRulePatchWithoutMachineValues() throws {
        var merge = try RepoRuleMerge(project: project())
        #expect(merge.differingFields == ["criticEnabled", "defaultModel"])
        #expect(!merge.ready)
        merge.selections = ["criticEnabled": "linux", "defaultModel": "mac"]
        #expect(!merge.ready) // Both machines drain: an explicit leader is required.
        merge.leader = "linux"
        #expect(merge.ready)
        let body = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(merge.patch())) as? [String: Any])
        let rules = try #require(body["rules"] as? [String: Any])
        #expect(rules["criticEnabled"] as? Bool == true)
        #expect(rules["defaultModel"] as? String == "inherit")
        #expect(rules["autoDrainEnabled"] as? Bool == true)
        #expect(rules.count == merge.fields.count)
        #expect(rules["maxAuto"] == nil)
        #expect(rules["sandboxProfile"] == nil)
        #expect(body["leitrechner"] as? String == "linux")
        #expect(merge.equalFields.count == merge.fields.count - 2)
    }

    @Test func unavailableOrUnknownChoicesCannotCompleteMerge() throws {
        var project = try project()
        project.machines[1].reachable = false
        var merge = try RepoRuleMerge(project: project)
        merge.selections = ["criticEnabled": "linux", "defaultModel": "missing"]
        merge.leader = "mac"
        #expect(!merge.ready)
        merge.selections["defaultModel"] = "mac"
        merge.leader = "linux"
        #expect(!merge.ready)
        merge.leader = "mac"
        #expect(merge.ready)
        #expect(merge.value("maxAuto", machine: "mac") == nil)
    }
}
