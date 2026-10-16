import Foundation
import ShepherdKit

/// One child's place in its epic: what it needs, its stage, and what it frees — the web's
/// "Braucht zuerst → Dieses Issue → Gibt frei" (EpicChildSteps.svelte, epic-child.ts).
public struct EpicChain: Sendable, Equatable {
    public struct Need: Sendable, Equatable {
        public let number: Int
        public let merged: Bool
    }

    public let number: Int
    public let stage: Int
    public let stageCount: Int
    /// The child's blockers inside the epic, merged or not.
    public let needs: [Need]
    /// Unmerged siblings that wait on this child, in epic order.
    public let unlocks: [Int]
    /// How many of `unlocks` become startable once this child lands (no other open blocker).
    public let parallel: Int
    /// Every other child is merged: the epic lands after this one.
    public let isLast: Bool

    public init?(_ number: Int, flow: EpicFlow, children: [EpicChild]) {
        guard let stage = flow.stage(of: number) else { return nil }
        let merged = Set(children.filter(\.isMerged).map(\.number))
        let dependents = children
            .sorted { $0.order != $1.order ? $0.order < $1.order : $0.number < $1.number }
            .filter { $0.number != number && !$0.isMerged && $0.blockedBy.contains(number) }
        self.number = number
        self.stage = stage
        stageCount = flow.stages.count
        needs = (flow.blockers[number] ?? []).map { Need(number: $0, merged: merged.contains($0)) }
        unlocks = dependents.map(\.number)
        parallel = dependents.filter { $0.blockedBy.allSatisfy { $0 == number || merged.contains($0) } }.count
        isLast = children.allSatisfy { $0.number == number || $0.isMerged }
    }
}
