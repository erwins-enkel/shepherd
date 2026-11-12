import Foundation
import ShepherdKit

/// Only the contract's repository rules participate; machine settings never enter the patch.
public struct RepoRuleMerge {
    public let project: RepoConfigProject
    public var selections: [String: String] = [:]
    public var leader = ""
    private let baseline: [String: NSObject]

    public init(project: RepoConfigProject) throws {
        self.project = project
        if var rules = project.rules {
            rules.additionalProperties = .init()
            baseline = try Self.values(rules)
        } else { baseline = [:] }
    }

    public var fields: [String] { baseline.keys.sorted() }
    public var differingFields: [String] {
        fields.filter { field in
            Set(project.machines.compactMap { value(field, machine: $0.instanceId)?.description }).count > 1
        }
    }
    public var equalFields: [String] { fields.filter { !differingFields.contains($0) } }
    public var needsLeader: Bool {
        project.machines.contains { $0.config?.autoDrainEnabled == true || $0.config?.criticAllPrs == true }
    }
    public var ready: Bool {
        !baseline.isEmpty && differingFields.allSatisfy { field in
            selections[field].flatMap { value(field, machine: $0) } != nil
        } && (!needsLeader || project.machines.contains { $0.instanceId == leader && $0.reachable && $0.config != nil })
    }
    public func value(_ field: String, machine: String) -> NSObject? {
        guard baseline[field] != nil, let config = project.machines.first(where: { $0.instanceId == machine })?.config else { return nil }
        return (try? Self.values(config))?[field]
    }
    public func patch() throws -> RepoProjectPatch {
        var rules = baseline
        for field in differingFields { rules[field] = selections[field].flatMap { value(field, machine: $0) } }
        let body: [String: Any] = ["rules": rules, "leitrechner": leader.isEmpty ? NSNull() : leader as Any]
        return try JSONDecoder().decode(RepoProjectPatch.self, from: JSONSerialization.data(withJSONObject: body))
    }
    private static func values<T: Encodable>(_ value: T) throws -> [String: NSObject] {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: NSObject] ?? [:]
    }
}
