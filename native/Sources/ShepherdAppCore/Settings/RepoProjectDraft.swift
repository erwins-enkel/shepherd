import Foundation
import ShepherdKit

/// A rule edit stays local until one project PUT commits the whole selection.
public struct RepoProjectDraft {
    public struct Change: Identifiable {
        public let id: String
        public let before: String
        public let after: String
    }
    public let original: RepoRules
    public var rules: RepoRules
    public let originalLeader: String?
    public var leader: String?

    public init(rules: RepoRules, leader: String?) {
        original = rules; self.rules = rules
        originalLeader = leader; self.leader = leader
    }

    public func changes() throws -> [Change] {
        let old = try values(original), new = try values(rules)
        var result = new.keys.sorted().compactMap { key -> Change? in
            guard old[key] != new[key], let value = new[key] else { return nil }
            return Change(id: key, before: old[key]?.description ?? "", after: value.description)
        }
        if leader != originalLeader {
            result.append(Change(id: "leitrechner", before: originalLeader ?? "", after: leader ?? ""))
        }
        return result
    }

    public func patch() throws -> RepoProjectPatch {
        let old = try values(original), new = try values(rules)
        let changed = new.filter { old[$0.key] != $0.value }
        var body: [String: Any] = [:]
        if !changed.isEmpty { body["rules"] = changed }
        var patch = try JSONDecoder().decode(RepoProjectPatch.self, from: JSONSerialization.data(withJSONObject: body))
        if leader != originalLeader { patch.leitrechner = try .init(unvalidatedValue: leader) }
        return patch
    }

    private func values(_ rules: RepoRules) throws -> [String: NSObject] {
        // The contract restricts rules to scalar strings and booleans.
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(rules)) as? [String: NSObject] ?? [:]
    }
}
