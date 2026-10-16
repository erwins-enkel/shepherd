import Foundation
import ShepherdKit

/// The children an epic group shows no session for, by stage — the iOS list's folded
/// "Weitere Schritte" row.
public struct EpicFold: Sendable, Equatable {
    public struct Item: Sendable, Equatable {
        public let child: EpicChild
        /// Unmerged siblings waiting on it.
        public let unlocks: Int
    }

    public struct Stage: Sendable, Equatable {
        public let index: Int
        /// The listed children's in-epic blockers, ascending.
        public let after: [Int]
        public let items: [Item]
    }

    public enum Summary: Sendable, Equatable {
        /// Children of the lowest folded stage that are ready to start.
        case ready(count: Int)
        /// The lowest folded stage waits on these open (unmerged) blockers.
        case waiting(on: [Int])
    }

    public let stages: [Stage]
    public let summary: Summary?
    public var count: Int { stages.reduce(0) { $0 + $1.items.count } }

    public init(flow: EpicFlow, children: [EpicChild], shown: Set<Int>) {
        let merged = Set(children.filter(\.isMerged).map(\.number))
        let open = children.filter { !$0.isMerged }
        let built: [Stage] = flow.stages.compactMap { stage in
            let items = stage.children
                .filter { !$0.isMerged && !shown.contains($0.number) }
                .map { child in
                    Item(child: child, unlocks: open.filter {
                        $0.number != child.number && $0.blockedBy.contains(child.number)
                    }.count)
                }
            guard !items.isEmpty else { return nil }
            let after = Set(items.flatMap { flow.blockers[$0.child.number] ?? [] }).sorted()
            return Stage(index: stage.index, after: after, items: items)
        }
        stages = built
        if let first = built.first {
            let ready = first.items.filter { $0.child.isReady }.count
            let waitingOn = first.after.filter { !merged.contains($0) }
            summary = ready > 0 ? .ready(count: ready) : waitingOn.isEmpty ? nil : .waiting(on: waitingOn)
        } else {
            summary = nil
        }
    }
}
