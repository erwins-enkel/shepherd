import Foundation
import ShepherdKit

extension EpicChild {
    public var isMerged: Bool { state.rawValue == "merged" }
    /// Running or in review: work in flight (the web's `inFlight` in epic-timing-text.ts).
    public var isInFlight: Bool { state.rawValue == "running" || state.rawValue == "in-review" }
    public var isReady: Bool { state.rawValue == "ready" }
}

/// The stages of an epic's `blockedBy` graph — a port of `layoutEpicFlow` in
/// ui/src/lib/epic-flow.ts. A child with no blocker inside the epic sits in stage 1, every other
/// one right after its latest blocker. Self-references and blockers outside the epic are ignored;
/// on a cycle the edge that closes it is dropped, so every child gets a finite stage. Children are
/// walked in epic `order`; within a stage they sort by the mean row of their blockers, then by
/// `order`.
public struct EpicFlow: Sendable, Equatable {
    public struct Stage: Sendable, Equatable {
        /// 1-based.
        public let index: Int
        public let children: [EpicChild]
        public var parallel: Bool { children.count >= 2 }
    }

    public let stages: [Stage]
    /// Each child's blockers inside the epic: deduplicated, self-references dropped.
    public let blockers: [Int: [Int]]

    public init(_ children: [EpicChild]) {
        let sorted = children.sorted { $0.order != $1.order ? $0.order < $1.order : $0.number < $1.number }
        let inEpic = Set(sorted.map(\.number))
        var preds: [Int: [Int]] = [:]
        for child in sorted {
            var seen: Set<Int> = []
            preds[child.number] = child.blockedBy.filter {
                $0 != child.number && inEpic.contains($0) && seen.insert($0).inserted
            }
        }

        var stageOf: [Int: Int] = [:]
        var onStack: Set<Int> = []
        var kept: [(from: Int, to: Int)] = []
        func visit(_ number: Int) -> Int {
            if let known = stageOf[number] { return known }
            onStack.insert(number)
            var stage = 1
            for blocker in preds[number] ?? [] where !onStack.contains(blocker) {
                stage = max(stage, visit(blocker) + 1)
                kept.append((from: blocker, to: number))
            }
            onStack.remove(number)
            stageOf[number] = stage
            return stage
        }
        for child in sorted { _ = visit(child.number) }

        var rowOf: [Int: Int] = [:]
        func meanBlockerRow(_ number: Int) -> Double {
            let rows = kept.filter { $0.to == number }.map { Double(rowOf[$0.from] ?? 0) }
            return rows.isEmpty ? 0 : rows.reduce(0, +) / Double(rows.count)
        }
        var built: [Stage] = []
        let count = stageOf.values.max() ?? 0
        if count > 0 {
            for index in 1...count {
                let members = sorted.enumerated()
                    .filter { stageOf[$0.element.number] == index }
                    .map { (child: $0.element, rank: $0.offset, key: meanBlockerRow($0.element.number)) }
                    .sorted { $0.key != $1.key ? $0.key < $1.key : $0.rank < $1.rank }
                    .map { $0.child }
                for (row, child) in members.enumerated() { rowOf[child.number] = row }
                built.append(Stage(index: index, children: members))
            }
        }
        stages = built
        blockers = preds
    }

    public func stage(of number: Int) -> Int? {
        stages.first { $0.children.contains { $0.number == number } }?.index
    }

    /// First stage with at least two unmerged children — where more agent slots start to pay off.
    public var firstParallelStage: Int? {
        stages.first { $0.children.filter { !$0.isMerged }.count >= 2 }?.index
    }

    /// The lowest stage that still has an unmerged child; nil once every child is merged.
    public var currentStage: Int? {
        stages.first { $0.children.contains { !$0.isMerged } }?.index
    }
}
