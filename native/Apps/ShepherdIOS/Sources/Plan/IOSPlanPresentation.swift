import Observation
import ShepherdAppCore
import ShepherdKit

@MainActor
enum IOSPlanStream {
    static func install(into app: AppModel) {
        // ReadOnlySidebar already registers PlanModel before Herd consumes PlanSignals.
        // Registration is idempotent; no Mac host or second event connection is installed.
        app.register(PlanModel.self)
        app.register(IOSPlanController.self)
        SessionSignals.planQuestionsUnanswered = { [weak app] id in
            app?.extension(PlanModel.self)?.questionsUnanswered(id) ?? false
        }
    }
}

@Observable @MainActor
final class IOSPlanAccess {
    var visible = false
    var active = false
    var sendingAnswers = false
    var sendingSteer = false
    let current: @MainActor () -> Bool
    init(current: @escaping @MainActor () -> Bool) { self.current = current }
    var allowed: Bool { visible && active && current() }
}

/// A presentation lease belongs to one session and activation, never to the list selection.
@Observable @MainActor
final class IOSPlanPresentation {
    let actions: PlanTabActions
    let access: IOSPlanAccess
    private let writer: QuestionFormWriter?
    private var forms: [Int: QuestionFormModel] = [:]
    private var formHashes: [Int: String] = [:]
    private var wasAllowed = false
    private let sendSteer: (@MainActor (String) async throws -> Void)?
    var steer: IOSPlanSteer?

    init(session: Session, model: PlanModel, writer: PlanTabWriter,
         answerWriter: QuestionFormWriter?, current: @escaping @MainActor () -> Bool,
         sendSteer: (@MainActor (String) async throws -> Void)? = nil) {
        let access = IOSPlanAccess(current: current)
        self.access = access
        actions = PlanTabActions(session: session, model: model, writer: writer,
            isCurrent: { access.allowed && !access.sendingAnswers && !access.sendingSteer })
        self.writer = answerWriter
        self.sendSteer = sendSteer
        synchronizeForms()
    }

    var allowsActions: Bool { access.allowed && !access.sendingAnswers && !access.sendingSteer }
    var questionsLocked: Bool { !allowsActions || actions.inFlight || actions.quotaBusy != nil }

    func prepareSteer() {
        guard allowsActions, actions.stalled, actions.quotaBusy == nil, let gate = actions.gate, let sendSteer else { return }
        if steer?.gate == gate { return }
        steer = IOSPlanSteer(gate: gate, current: { [weak self] in
            guard let self else { return false }
            return self.access.allowed && !self.access.sendingAnswers && self.actions.stalled
                && self.actions.quotaBusy == nil && self.actions.gate == gate
        }, busyChanged: { [weak self] busy in
            self?.access.sendingSteer = busy
            self?.update()
        }, writer: sendSteer)
    }

    func update(session: Session? = nil, visible: Bool? = nil, active: Bool? = nil) {
        if let session { actions.session = session }
        if let visible { access.visible = visible }
        if let active { access.active = active }
        if wasAllowed && !access.allowed { suspendPresentation() }
        wasAllowed = access.allowed
        actions.reconcile()
        if let steer, steer.gate != actions.gate { steer.invalidate(); self.steer = nil }
        synchronizeForms()
        for (index, form) in forms {
            form.answerContext = context(for: index, block: form.block)
        }
        if !access.allowed { actions.cancelConfirmation() }
    }

    private func synchronizeForms() {
        let blocks = actions.gate?.blocks ?? []
        for index in Array(forms.keys) where !blocks.indices.contains(index) || blocks[index].value13 == nil {
            forms[index]?.answerContext = nil
            forms[index]?.invalidatePresentationForIOS()
            forms[index] = nil
            formHashes[index] = nil
        }
        for (index, block) in blocks.enumerated() {
            if let value = block.value13 { _ = form(at: index, block: value) }
        }
    }

    func form(at index: Int, block: VisualBlockQuestionForm) -> QuestionFormModel {
        let planHash = actions.gate?.planHash
        if let form = forms[index], form.block == block, formHashes[index] == planHash { return form }
        forms[index]?.answerContext = nil
        forms[index]?.invalidatePresentationForIOS()
        let guarded = writer?.guardedForIOS(isCurrent: { [weak self] in
            guard let self else { return false }
            return self.access.allowed && self.actions.gate?.planHash == planHash
                && self.actions.answerContext != nil
                && !self.actions.inFlight && self.actions.quotaBusy == nil && !self.access.sendingSteer
                && self.actions.gate?.blocks?.indices.contains(index) == true
                && self.actions.gate?.blocks?[index].value13 == block
        }, submissionChanged: { [weak self] busy in
            self?.access.sendingAnswers = busy
            self?.update()
        })
        let form = QuestionFormModel(block: block, answerContext: context(for: index, block: block), writer: guarded)
        forms[index] = form
        formHashes[index] = planHash
        return form
    }

    func answered(_ block: VisualBlockQuestionForm) -> Bool {
        let keys = Set(actions.gate?.answeredQuestionKeys ?? [])
        return !block.questions.isEmpty && block.questions.allSatisfy { keys.contains("\(block.id) \($0.id)") }
    }

    func disappear() {
        access.visible = false
        wasAllowed = false
        suspendPresentation()
        for form in forms.values { form.answerContext = nil }
    }

    private func suspendPresentation() {
        actions.invalidatePresentationForIOS()
        steer?.invalidate()
        for form in forms.values { form.invalidatePresentationForIOS() }
    }

    func teardown() {
        disappear()
        actions.teardown()
    }

    private func context(for index: Int, block: VisualBlockQuestionForm) -> QuestionAnswerContext? {
        guard access.allowed, !answered(block),
              actions.gate?.blocks?.indices.contains(index) == true,
              actions.gate?.blocks?[index].value13 == block else { return nil }
        // PlanTabActions owns planning/executing and review/quota locks.
        return actions.answerContext?.lockedForIOS(questionsLocked)
    }

    static func opensPlan(session: Session, model: PlanModel) -> Bool {
        opensPlan(session: session, gate: model.gates[session.id], questionsUnanswered: model.questionsUnanswered(session.id))
    }

    static func opensPlan(session: Session, gate: PlanGate?, questionsUnanswered: Bool) -> Bool {
        guard session.planPhase?.known == .planning else { return false }
        return questionsUnanswered || gate?.approved == true
            || session.autopilotPaused || session.status.known == .blocked
            || (gate?.round ?? 0) >= (gate?.cap ?? Int.max)
    }
}
