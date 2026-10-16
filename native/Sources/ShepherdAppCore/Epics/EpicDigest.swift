import Foundation
import ShepherdKit

/// One loaded epic and everything the iOS epic surfaces derive from it, computed once per load.
public struct EpicDigest: Sendable {
    public let epic: Epic
    public let flow: EpicFlow

    public init(_ epic: Epic) {
        self.epic = epic
        flow = EpicFlow(epic.children)
    }

    public var total: Int { epic.children.count }
    public var merged: Int { epic.children.filter(\.isMerged).count }
    public var inFlight: Int { epic.children.filter(\.isInFlight).count }
    public var meter: [EpicMeterTone] { EpicMeter.tones(epic.children) }

    /// The child a session works on: by session id, else by issue number.
    public func child(session id: String, issue: Int?) -> EpicChild? {
        epic.children.first { $0.sessionId == id }
            ?? issue.flatMap { number in epic.children.first { $0.number == number } }
    }

    public func chain(_ number: Int) -> EpicChain? {
        EpicChain(number, flow: flow, children: epic.children)
    }

    public func fold(shown: Set<Int>) -> EpicFold {
        EpicFold(flow: flow, children: epic.children, shown: shown)
    }
}
