import XCTest
import SwiftUI
import UIKit
import ShepherdKit
@testable import ShepherdAppCore
@testable import ShepherdIOS

@MainActor
final class IOSPlanTests: XCTestCase {
    private func session() -> Session {
        var session = PreviewData.session(name: "iOS plan gates", prompt: "Bring agent decisions to the phone.")
        session.planPhase = .init(known: .planning)
        session.status = .init(known: .done)
        return session
    }
    private func block(_ id: String = "questions") -> VisualBlockQuestionForm {
        .init(_type: .questionForm, id: id, questions: [
            .init(id: "scope", prompt: "Where should plan decisions appear?", kind: .init(known: .single), options: ["Session detail and list", "Session detail only"]),
            .init(id: "checks", prompt: "Which checks should we include?", kind: .init(known: .multi), options: ["VoiceOver", "Dynamic Type"]),
            .init(id: "note", prompt: "Anything else to keep in mind?", kind: .init(known: .freeform)),
        ])
    }
    private func gate(forms: Bool = false, approved: Bool = true) -> PlanGate {
        .init(sessionId: session().id, planHash: "reviewed", decision: .init(known: approved ? .approved : .changesRequested),
            summary: approved ? "Plan approved; ready for your go-ahead." : "Clarify the phone interaction before implementation.",
            body: "", findings: approved ? [] : ["Keep answer choices reachable at larger text sizes."],
            round: 1, cap: 3, approved: approved,
            plan: "# Phone plan\n\nReuse shared plan state and question submission.\n\n- Open Plan from attention badges.\n- Keep choices and errors visible.\n- Respect read-only launches.",
            blocks: forms ? [.init(value13: block())] : nil, updatedAt: 1)
    }
    private func model(_ gate: PlanGate?) async -> PlanModel {
        let model = PlanModel(reads: .init(gates: { gate.map { [$0.sessionId: $0] } ?? [:] }, inflight: { [] }))
        await model.refresh()
        return model
    }
    private func presentation(_ gate: PlanGate?, fake: IOSPlanRecorder = IOSPlanRecorder()) async -> IOSPlanPresentation {
        let p = IOSPlanPresentation(session: session(), model: await model(gate), writer: fake.planWriter,
            answerWriter: fake.answerWriter, current: { fake.current }, sendSteer: { try await fake.sendSteer($0) })
        p.update(visible: true, active: true)
        return p
    }
    private func fill(_ form: QuestionFormModel) {
        form.single["scope"] = 0
        form.multi["checks"] = [1, 0]
        form.freeform["note"] = "  Keep the full plan visible.\n"
    }
    private func settle(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        let deadline = ContinuousClock.now + .seconds(15)
        while !condition(), ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertTrue(condition(), file: file, line: line)
    }

    func testAttentionRowsRouteToPlanButOrdinaryAndExecutingRowsKeepTerminal() async {
        var s = session()
        let m = await model(gate(forms: true, approved: false))
        XCTAssertTrue(IOSPlanPresentation.opensPlan(session: s, model: m))
        let card = IOSSessionListPresentation.card(s, displayed: s, questionsUnanswered: true,
            planGate: m.gates[s.id], now: s.createdAt)
        XCTAssertTrue(card.opensPlan)
        XCTAssertTrue(card.badges.contains { $0.id == "answer" })
        XCTAssertTrue(card.badges.contains { $0.id == "plan" })
        s.planPhase = .init(known: .executing)
        XCTAssertFalse(IOSPlanPresentation.opensPlan(session: s, model: m))
        XCTAssertFalse(IOSSessionListPresentation.card(s, displayed: s, questionsUnanswered: true, now: s.createdAt).badges.contains { $0.id == "answer" })
        s.planPhase = nil
        s.status = .init(known: .blocked)
        XCTAssertFalse(IOSPlanPresentation.opensPlan(session: s, model: m), "Non-plan terminal questions still open Terminal")
        s.planPhase = .init(known: .planning)
        s.status = .init(known: .running)
        XCTAssertFalse(IOSPlanPresentation.opensPlan(session: s, gate: nil, questionsUnanswered: false))
    }

    func testReadyAndStalledGatesOpenPlanWithoutQuestions() {
        XCTAssertTrue(IOSPlanPresentation.opensPlan(session: session(), gate: gate(), questionsUnanswered: false))
        var stalled = gate(approved: false)
        stalled.round = stalled.cap
        XCTAssertTrue(IOSPlanPresentation.opensPlan(session: session(), gate: stalled, questionsUnanswered: false))
    }

    func testIsolationNavigationAndBackgroundFenceEveryMutation() async {
        let fake = IOSPlanRecorder()
        let p = await presentation(gate(forms: true), fake: fake)
        let form = p.form(at: 0, block: block())
        fill(form)
        form.requestConfirmation()
        p.actions.requestConfirmation()
        fake.current = false // isolation/activation/selection guard changes before onDisappear
        await form.confirmSubmission()
        await p.actions.release()
        await p.actions.review()
        XCTAssertTrue(fake.answers.isEmpty)
        XCTAssertEqual(fake.releases, 0)
        XCTAssertEqual(fake.reviews, 0)
        fake.current = true
        p.update(active: false)
        XCTAssertNil(form.answerContext)
        p.actions.requestConfirmation()
        await p.actions.release()
        XCTAssertEqual(fake.releases, 0)
        p.update(active: true)
        XCTAssertNotNil(form.answerContext)
        p.disappear()
        XCTAssertNil(form.answerContext)
        await p.actions.review()
        XCTAssertEqual(fake.reviews, 0)
    }

    func testAnswersUseSharedPayloadProgressAndPreventDuplicateOrConcurrentActions() async {
        let fake = IOSPlanRecorder()
        fake.hold = true
        let p = await presentation(gate(forms: true), fake: fake)
        let form = p.form(at: 0, block: block())
        fill(form)
        form.requestConfirmation()
        let send = Task { await form.confirmSubmission() }
        await settle { fake.pending != nil }
        XCTAssertTrue(form.submitting)
        XCTAssertTrue(form.inputsDisabled)
        XCTAssertFalse(p.allowsActions)
        XCTAssertNotNil(form.answerContext, "Keep submission progress visible")
        await form.confirmSubmission()
        await p.actions.review()
        p.actions.requestConfirmation()
        await p.actions.release()
        XCTAssertEqual(fake.answers.count, 1)
        XCTAssertEqual(fake.reviews, 0)
        XCTAssertEqual(fake.releases, 0)
        XCTAssertEqual(fake.answers[0].1.map(\.blockId), ["questions", "questions", "questions"])
        XCTAssertEqual(fake.answers[0].1[0].optionIndices, [0])
        XCTAssertEqual(fake.answers[0].1[1].optionIndices, [0, 1])
        XCTAssertEqual(fake.answers[0].1[2].text, "  Keep the full plan visible.\n")
        fake.resume()
        await send.value
        XCTAssertEqual(form.footerMessage, L.t("qform_sent"))
        XCTAssertFalse(form.canSubmit)
        XCTAssertTrue(p.allowsActions)
    }

    func testFailureRetainsDraftAllowsRetryAndUndeliveredAnswersStayRecorded() async {
        let fake = IOSPlanRecorder()
        fake.fail = true
        let p = await presentation(gate(forms: true), fake: fake)
        let form = p.form(at: 0, block: block())
        fill(form)
        form.requestConfirmation()
        await form.confirmSubmission()
        XCTAssertTrue(form.errored)
        XCTAssertTrue(form.canSubmit)
        XCTAssertEqual(form.freeform["note"], "  Keep the full plan visible.\n")
        fake.fail = false
        fake.delivered = false
        form.requestConfirmation()
        await form.confirmSubmission()
        XCTAssertTrue(form.footerIsWarning)
        XCTAssertEqual(form.footerMessage, L.t("qform_sent_undelivered"))
        XCTAssertFalse(form.canSubmit)
    }

    func testBlockChangesFenceConfirmationAndLateCompletion() async throws {
        let fake = IOSPlanRecorder()
        fake.hold = true
        let p = await presentation(gate(forms: true), fake: fake)
        let old = p.form(at: 0, block: block())
        fill(old)
        old.requestConfirmation()
        let send = Task { await old.confirmSubmission() }
        await settle { fake.pending != nil }
        var replacement = gate(forms: true)
        var changed = block()
        changed.questions[0].options = ["A new choice"]
        replacement.blocks = [.init(value13: changed)]
        p.actions.model.receive(.unknown(name: "session:plangate", payload: try JSONEncoder().encode(SessionPlanGateEvent(id: session().id, gate: replacement))))
        p.update()
        let new = p.form(at: 0, block: changed)
        XCTAssertFalse(old === new)
        XCTAssertNil(old.answerContext)
        XCTAssertFalse(new.canSubmit)
        fake.resume()
        await send.value
        XCTAssertNil(old.footerMessage)
        XCTAssertNil(new.footerMessage)
    }

    func testQuestionIdentitiesAreBlockScopedAndAlreadyAnsweredFormsAreReadOnly() async {
        var g = gate(forms: true)
        g.blocks = [.init(value13: block("first")), .init(value13: block("second"))]
        g.answeredQuestionKeys = block("first").questions.map { "first \($0.id)" }
        let p = await presentation(g)
        let first = p.form(at: 0, block: block("first"))
        let second = p.form(at: 1, block: block("second"))
        XCTAssertTrue(p.answered(block("first")))
        XCTAssertNil(first.answerContext)
        XCTAssertTrue(first.inputsDisabled)
        fill(second)
        XCTAssertTrue(second.canSubmit)
        XCTAssertNil(first.single["scope"] ?? nil)
    }

    func testReviewAndExecutionLockQuestionsAndInvalidatePendingConsent() async throws {
        let p = await presentation(gate(forms: true, approved: false))
        let form = p.form(at: 0, block: block())
        fill(form)
        form.requestConfirmation()
        p.actions.model.receive(.unknown(name: "session:plangate-reviewing", payload: try JSONEncoder().encode(SessionPlanGateReviewingEvent(id: session().id, reviewing: true))))
        p.update()
        XCTAssertTrue(form.inputsDisabled)
        XCTAssertFalse(form.confirming)
        var executing = session()
        executing.planPhase = .init(known: .executing)
        p.update(session: executing)
        XCTAssertNil(form.answerContext)
        XCTAssertFalse(p.actions.canRelease)
    }

    func testGoFailureStaleVerdictAndDoubleTapUseSharedConsentRules() async throws {
        let fake = IOSPlanRecorder()
        fake.fail = true
        let p = await presentation(gate(), fake: fake)
        p.actions.requestConfirmation()
        await p.actions.release()
        XCTAssertEqual(p.actions.releaseNote.map { L.t($0) }, L.t("planpanel_native_go_failed"))
        fake.fail = false
        p.actions.requestConfirmation()
        var g = gate()
        g.planHash = "new-revision"
        p.actions.model.receive(.unknown(name: "session:plangate", payload: try JSONEncoder().encode(SessionPlanGateEvent(id: session().id, gate: g))))
        p.update()
        await p.actions.release()
        XCTAssertEqual(fake.releases, 1, "Changing verdict cancels old consent")
        fake.hold = true
        p.actions.requestConfirmation()
        let send = Task { await p.actions.release() }
        await settle { fake.pending != nil }
        await p.actions.release()
        XCTAssertEqual(fake.releases, 2)
        fake.resume()
        await send.value
        XCTAssertFalse(p.actions.canRelease, "Suppress a repeat Go before SessionStore catches up")
    }

    func testPlanStreamConnectsQuestionSignalForCurrentActivation() async throws {
        let launch = try IOSLaunchEnvironment(configuration: .init(isIsolated: true))
        let app = launch.makeModel()
        let profile = try app.addRemoteProfile(name: "Fixture", address: "http://127.0.0.1:1")
        await app.activate(profile)
        defer { app.deactivate() }
        let m = try XCTUnwrap(app.extension(PlanModel.self))
        let g = gate(forms: true)
        m.receive(.unknown(name: "session:plangate", payload: try JSONEncoder().encode(SessionPlanGateEvent(id: session().id, gate: g))))
        XCTAssertTrue(SessionSignals.planQuestionsUnanswered(session().id))
        XCTAssertFalse(app.allowsTerminalInput)
        XCTAssertNotNil(app.liveRequestAudit)
        app.deactivate()
        XCTAssertFalse(SessionSignals.planQuestionsUnanswered(session().id))
    }

    func testMarkdownPreservesHeadingsListMarkersAndLiteralCode() {
        let blocks = IOSPlanMarkdownView.blocks("# Title\n\n1. First\n2. Second\n\n```\n<script>alert(1)</script>\n```")
        XCTAssertTrue(blocks.contains { $0.heading })
        XCTAssertTrue(blocks.contains { $0.marker == "1." })
        XCTAssertTrue(blocks.contains { String($0.text.characters).contains("<script>") })
    }

    func testSteerKeepsOperatorNoteOnFailureAndPreventsRepeatSend() async throws {
        let fake = IOSPlanRecorder()
        var stalled = gate(approved: false)
        stalled.round = stalled.cap
        let p = await presentation(stalled, fake: fake)
        p.prepareSteer()
        let steer = try XCTUnwrap(p.steer)
        XCTAssertTrue(steer.draft.contains(stalled.findings[0]))
        steer.draft += "\n\nOperator note: keep this narrow."
        let note = steer.draft
        fake.fail = true
        await steer.send()
        XCTAssertEqual(steer.draft, note)
        XCTAssertEqual(steer.outcome.map { L.t($0) }, L.t("plangate_repair_send_failed"))
        XCTAssertTrue(steer.canSend)
        fake.fail = false
        fake.hold = true
        let send = Task { await steer.send() }
        await settle { fake.pending != nil }
        XCTAssertTrue(steer.submitting)
        XCTAssertFalse(p.allowsActions)
        await steer.send()
        await p.actions.quota(resume: true)
        XCTAssertTrue(fake.quotas.isEmpty)
        XCTAssertEqual(fake.steers, [note, note])
        fake.resume()
        await send.value
        XCTAssertTrue(steer.sent)
        XCTAssertFalse(steer.canSend)
    }

    func testQuotaProgressLocksFormsAndLateBackgroundCompletionIsIgnored() async {
        let fake = IOSPlanRecorder()
        fake.hold = true
        var g = gate(forms: true, approved: false)
        g.round = g.cap
        let p = await presentation(g, fake: fake)
        let form = p.form(at: 0, block: block())
        fill(form)
        form.requestConfirmation()
        let send = Task { await p.actions.quota(resume: true) }
        await settle { fake.pending != nil }
        await form.confirmSubmission()
        XCTAssertTrue(fake.answers.isEmpty, "The writer fences buffered taps before SwiftUI reconciles its controls")
        p.update()
        XCTAssertTrue(form.inputsDisabled)
        await p.actions.quota(resume: false)
        XCTAssertEqual(fake.quotas, [true])
        p.update(active: false)
        fake.resume()
        await send.value
        XCTAssertNil(p.actions.quotaOutcome)
        XCTAssertNil(form.answerContext)
    }

    func testVisualBlocksRenderContractMembersAndKeepUnknownContentInert() async throws {
        let json = #"""
        [
          {"type":"rich-text","id":"intro","markdown":"## Proposed architecture"},
          {"type":"callout","id":"decision","tone":"decision","markdown":"Reuse shared state."},
          {"type":"file-tree","id":"files","entries":[{"path":"Sources/Plan/IOSPlanView.swift","change":"added","note":"Phone layout"}]},
          {"type":"table","id":"matrix","columns":["State","Action"],"rows":[["Approved","Go"],["Questions","Answer"]]},
          {"type":"checklist","id":"checks","items":[{"id":"voice","label":"VoiceOver","checked":true}]},
          {"type":"code","id":"code","filename":"Plan.swift","code":"let state = shared.plan"},
          {"type":"annotated-code","id":"annotated","filename":"Question.swift","code":"send(answers)","annotations":[{"note":"Guard selection"}]},
          {"type":"diff","id":"diff","path":"Plan.swift","summary":"Add phone surface","annotations":[{"label":"Change","note":"Shared model"}]},
          {"type":"api-endpoint","id":"api","method":"POST","path":"/answer-plan-questions","params":[{"name":"answers","in":"body","type":"array"}],"responses":[{"status":200,"description":"Recorded"}]},
          {"type":"data-model","id":"model","entities":[{"id":"gate","name":"PlanGate","fields":[{"name":"approved","type":"boolean"}]}]},
          {"type":"mermaid","id":"graph","source":"flowchart LR; Plan --> Review"},
          {"type":"wireframe","id":"wire","surface":"mobile","html":"<script>throw new Error('must stay inert')</script>","caption":"Phone sketch"},
          {"type":"future-block","id":"future","markdown":"must stay inert"}
        ]
        """#
        var g = gate()
        g.blocks = try JSONDecoder().decode([VisualBlock].self, from: Data(json.utf8))
        try g.validateVisualBlocks()
        let p = await presentation(g)
        let view = IOSVisualBlocksView(blocks: try XCTUnwrap(g.blocks), presentation: p, fixture: true)
            .sessionFont().foregroundStyle(SessionListStyle.ink).padding(16)
            .frame(width: 390).background(SessionListStyle.background)
        let renderer = ImageRenderer(content: view)
        XCTAssertNotNil(renderer.uiImage)
        let directory = URL(fileURLWithPath: "/private/tmp/claude-501/-Users-kai-osthoff-githubrepos-shepherd/36c6a6cb-46a0-4781-99da-a39e745b0a43/scratchpad/ios-plan")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try XCTUnwrap(renderer.uiImage?.pngData()).write(to: directory.appendingPathComponent("plan-visual-blocks.png"))
    }

    func testRenderKeyStatesToPNG() async throws {
        let directory = URL(fileURLWithPath: "/private/tmp/claude-501/-Users-kai-osthoff-githubrepos-shepherd/36c6a6cb-46a0-4781-99da-a39e745b0a43/scratchpad/ios-plan")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        func render<V: View>(_ name: String, _ view: V, height: CGFloat = 900) throws {
            let renderer = ImageRenderer(content: view.frame(width: 390, height: height, alignment: .top)
                .background(SessionListStyle.background).preferredColorScheme(.dark))
            renderer.scale = 2
            let png = try XCTUnwrap(renderer.uiImage?.pngData())
            XCTAssertGreaterThan(png.count, 5_000)
            try png.write(to: directory.appendingPathComponent(name + ".png"))
        }
        let ready = await presentation(gate())
        try render("plan-ready", IOSPlanBody(presentation: ready, fixture: true))
        let questions = await presentation(gate(forms: true, approved: false))
        try render("plan-questions", IOSPlanBody(presentation: questions, fixture: true), height: 1450)
        try render("plan-questions-large", IOSQuestionFormView(model: questions.form(at: 0, block: block()), fixture: true)
            .padding(16).environment(\.dynamicTypeSize, .accessibility3), height: 1900)
        var stalled = gate(approved: false)
        stalled.round = stalled.cap
        let p = await presentation(stalled)
        try render("plan-stalled", IOSPlanBody(presentation: p, fixture: true), height: 1050)
        p.prepareSteer()
        try render("plan-steer", IOSPlanSteerView(model: try XCTUnwrap(p.steer), fixture: true).padding(16), height: 850)
        p.actions.model.receive(.unknown(name: "session:plangate-reviewing", payload: try JSONEncoder().encode(SessionPlanGateReviewingEvent(id: session().id, reviewing: true))))
        p.update()
        try render("plan-reviewing", IOSPlanBody(presentation: p, fixture: true))
        var errored = gate(approved: false)
        errored.decision = .init(known: .error)
        errored.summaryCode = .init(known: .membraneLaunch)
        let errorPresentation = await presentation(errored)
        try render("plan-error", IOSPlanBody(presentation: errorPresentation, fixture: true))
        let readonly = await presentation(gate(forms: true))
        var executing = session()
        executing.planPhase = .init(known: .executing)
        readonly.update(session: executing)
        try render("plan-readonly", IOSPlanBody(presentation: readonly, fixture: true), height: 1450)
        ready.update(active: false)
        try render("plan-isolated", IOSPlanBody(presentation: ready, fixture: true))

        let fake = IOSPlanRecorder()
        fake.fail = true
        let feedback = await presentation(gate(forms: true), fake: fake)
        let form = feedback.form(at: 0, block: block())
        fill(form)
        form.requestConfirmation()
        await form.confirmSubmission()
        try render("question-error", IOSQuestionFormView(model: form, fixture: true).padding(16), height: 850)
        fake.fail = false
        fake.hold = true
        fake.delivered = false
        form.requestConfirmation()
        let send = Task { await form.confirmSubmission() }
        await settle { fake.pending != nil }
        try render("question-submitting", IOSQuestionFormView(model: form, fixture: true).padding(16), height: 850)
        fake.resume()
        await send.value
        try render("question-undelivered", IOSQuestionFormView(model: form, fixture: true).padding(16), height: 850)

        var s = session()
        s.autopilotPaused = true
        let card = IOSSessionListPresentation.card(s, displayed: s, questionsUnanswered: true,
            planGate: gate(forms: true, approved: false), now: s.createdAt + 80_000)
        try render("list-attention", SessionCardView(card: card, select: {}).padding(10), height: 260)
        try render("list-attention-large", SessionCardView(card: card, select: {}).padding(10)
            .environment(\.dynamicTypeSize, .accessibility3), height: 900)
        let terminal = IOSTerminalPresentation(session: TerminalSessionModel(sessionID: s.id, reply: { _ in },
            makeAttachment: { _, _ in fatalError("Plan fixture never mounts a terminal") }), reply: { _ in })
        let detail = IOSSessionDetailContent(session: s, model: DetailModel(loaders: .stubbed()), terminal: terminal,
            allowsInput: true, fontSize: .constant(12), surface: EmptyView(), tab: .plan, selectableText: false,
            planSurface: AnyView(IOSPlanBody(presentation: await presentation(gate()), fixture: true)),
            planEntryLabel: L.t("hold_cta_answer"))
        try render("detail-plan", detail)
    }
}

@MainActor
private final class IOSPlanRecorder {
    var current = true
    var fail = false
    var hold = false
    var delivered = true
    var reviews = 0
    var releases = 0
    var quotas: [Bool] = []
    var answers: [(String, [RawAnswer])] = []
    var steers: [String] = []
    func sendSteer(_ text: String) async throws { steers.append(text); try await wait() }
    var pending: CheckedContinuation<Void, Never>?
    var planWriter: PlanTabWriter {
        .init(review: { [self] _ in
            reviews += 1
            try await wait()
            return .init(ok: true, status: .init(known: .started))
        }, release: { [self] _ in
            releases += 1
            try await wait()
            return true
        }, quota: { [self] _, resume in
            quotas.append(resume)
            try await wait()
            return .init(ok: true, status: .init(known: resume ? .resumed : .dismissed))
        })
    }
    var answerWriter: QuestionFormWriter {
        .init(send: { [self] id, values in
            answers.append((id, values))
            try await wait()
            return .init(ok: true, delivered: delivered)
        }, isCurrent: { [self] in current })
    }
    private func wait() async throws {
        if hold { await withCheckedContinuation { pending = $0 } }
        if fail { throw ShepherdError.notFound }
    }
    func resume() { pending?.resume(); pending = nil }
}
