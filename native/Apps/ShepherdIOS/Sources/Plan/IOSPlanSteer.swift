import Observation
import ShepherdAppCore
import ShepherdKit

/// The mobile web's stalled-plan "Prepare steer" editor, including operator notes.
/// This requests a revision through reply; it never manufactures a reviewer verdict.
@Observable @MainActor
final class IOSPlanSteer {
    let gate: PlanGate
    var draft: String
    private(set) var submitting = false
    private(set) var outcome: StaticString?
    private(set) var sent = false
    private let current: @MainActor () -> Bool
    private let writer: @MainActor (String) async throws -> Void
    private let busyChanged: @MainActor (Bool) -> Void
    private var generation = 0

    init(gate: PlanGate, current: @escaping @MainActor () -> Bool,
         busyChanged: @escaping @MainActor (Bool) -> Void,
         writer: @escaping @MainActor (String) async throws -> Void) {
        self.gate = gate
        self.current = current
        self.busyChanged = busyChanged
        self.writer = writer
        let findings = gate.findings.isEmpty ? L.t("plangate_repair_no_findings") : gate.findings.map { "• " + $0 }.joined(separator: "\n")
        draft = L.t("plangate_repair_steer", findings)
    }
    var canSend: Bool { current() && !submitting && !sent && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    func send() async {
        guard canSend else { return }
        let mine = generation
        let text = draft
        submitting = true
        outcome = nil
        busyChanged(true)
        defer { submitting = false; busyChanged(false) }
        do {
            try await writer(text)
            sent = true // Delivery survives tab changes; presentation feedback does not.
            guard mine == generation, current(), !Task.isCancelled else { return }
            outcome = "plangate_repair_sent"
        } catch {
            guard mine == generation, current(), !Task.isCancelled else { return }
            outcome = "plangate_repair_send_failed"
        }
    }
    func invalidate() { generation &+= 1 }
}
