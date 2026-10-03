import Foundation
import Observation
import ShepherdAppCore
import ShepherdKit

/// iOS owns visibility and scene suspension; the shared model owns the PTY.
/// A renderer must be mounted before attaching so the initial replay is never lost.
@MainActor
@Observable
final class IOSTerminalPresentation {
    let session: TerminalSessionModel
    let allowsInput: Bool
    private(set) var followsTail = true
    private(set) var isAttached = false
    private(set) var replying = false
    private(set) var replyError: String?
    private(set) var voice: DictationController?
    private(set) var audioEngine: IOSDictationEngine?
    @ObservationIgnored private let readActions: () -> IOSSessionActionState?
    @ObservationIgnored private let makeDictation: (() -> IOSDictationSession?)?
    private var reattachPending = false
    private var lastServerStatus: SessionStatus?
    @ObservationIgnored private let reply: @Sendable (String) async throws -> Void
    @ObservationIgnored var scrollToTail: (@MainActor () -> Void)?
    private var visible = false
    private var active = false
    /// Wheel lines the operator scrolled up in the agent's own view (see `agentScrolled`).
    private var agentScrollDepth = 0
    private var rendererReady = false
    private var cols = 80
    private var rows = 24
    private var generation = 0

    init(session: TerminalSessionModel, allowsInput: Bool = true,
         actions: @escaping () -> IOSSessionActionState? = { nil },
         dictation: (() -> IOSDictationSession?)? = nil,
         reply: @escaping @Sendable (String) async throws -> Void) {
        self.session = session
        self.allowsInput = allowsInput
        self.reply = reply
        readActions = actions
        makeDictation = dictation
    }

    var canSendInput: Bool { allowsInput && isAttached && session.phase == .live }
    var canSubmitReply: Bool {
        canSendInput && !replying && !session.promptBusy && voice?.active != true &&
            !session.promptText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var actionState: IOSSessionActionState? { readActions() }
    var showsReplyBar: Bool { allowsInput }
    var canRecordReply: Bool { visible && active && rendererReady && canSendInput && !replying && !session.promptBusy }
    var canResume: Bool {
        allowsInput && session.phase == .ended(.gone)
            && actionState?.allowsWrites == true && actionState?.actions.contains(.resume) == true
    }

    func resume() async {
        guard canResume, let state = actionState, !state.busy else { return }
        await state.execute(.resume)
        guard state.allowsWrites, state.error == nil, state.outcome.note?.tone == .success else { return }
        requestReattach()
    }

    /// Also recover an ended terminal when the session-actions rail resumes it.
    func serverSessionChanged(_ value: SessionStatus) {
        defer { lastServerStatus = value }
        if let previous = lastServerStatus, previous.known != .running, value.known == .running,
           session.phase == .ended(.gone) { requestReattach() }
    }

    func resumeSucceeded() { requestReattach() }

    private func requestReattach() {
        guard session.phase == .ended(.gone) else { return }
        reattachPending = true
        if isAttached { reattachPending = false; session.takeOver() }
    }

    func prepareDictation() {
        guard allowsInput, voice == nil, let dictation = makeDictation?() else { return }
        audioEngine = dictation.engine
        voice = dictation.voice
        audioEngine?.probeWhisper()
    }

    // Fixture injection uses the same production controller and text destination.
    func installVoice(_ voice: DictationController) { self.voice = voice }

    func suspendDictation() {
        if voice?.capturing == true { voice?.finalize() }
        else if voice?.state == .arming { voice?.cancel() }
    }

    func teardown() {
        rendererUnmounted()
        voice?.teardown()
        audioEngine?.stopWhisperProbe()
    }

    func sendKey(_ key: IOSTerminalKey) {
        guard canSendInput else { return }
        session.send(Data(key.sequence.utf8))
    }

    /// Report success only to the attachment that submitted the draft.
    /// Reply state belongs to this session, independently of the PTY attachment.
    /// Keep the submitted draft until success so suspension cannot discard it.
    func submitReply() async -> Bool {
        guard canSubmitReply else { return false }
        let mine = generation
        let draft = session.promptText
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        replying = true
        replyError = nil
        defer { replying = false }
        do {
            try await reply(text)
            if session.promptText == draft { session.promptText = "" }
            return mine == generation
        } catch {
            replyError = L.t("native_terminal_prompt_failed", ShepherdErrorCopy.message(error))
            return false
        }
    }

    /// A saved steer travels the same reply route as a typed draft, but it never
    /// touches the draft, and like web's SteerBar it does not need an attached PTY.
    var canSendSteer: Bool { allowsInput && !replying && actionState?.allowsWrites != false }

    func sendSteer(_ text: String) async -> Bool {
        guard canSendSteer, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        replying = true
        replyError = nil
        defer { replying = false }
        do {
            try await reply(text)
            return true
        } catch {
            replyError = L.t("native_terminal_prompt_failed", ShepherdErrorCopy.message(error))
            return false
        }
    }

    func visibilityChanged(visible: Bool, active: Bool) {
        self.visible = visible
        self.active = active
        if !visible || !active { suspendDictation() }
        reconcile()
    }

    func rendererMounted(cols: Int, rows: Int) {
        self.cols = max(1, cols)
        self.rows = max(1, rows)
        rendererReady = true
        reconcile()
    }

    func rendererUnmounted() {
        suspendDictation()
        rendererReady = false
        reconcile()
        session.onOutput = nil
        session.onClear = nil
        scrollToTail = nil
    }

    func resize(cols: Int, rows: Int) {
        guard cols > 0, rows > 0, self.cols != cols || self.rows != rows else { return }
        self.cols = cols
        self.rows = rows
        if isAttached { session.resize(cols: cols, rows: rows) }
    }

    /// Only a user scroll changes follow state. Output and layout are not scroll intent.
    func userScrolled(position: Double, canScroll: Bool) {
        followsTail = !canScroll || position >= 1
    }

    /// Claude Code tracks the mouse and repaints its own scrolled transcript, so the local
    /// view never moves: count the forwarded wheel lines instead, like the web terminal's
    /// gesture accumulator. Returns false once scrolling down reaches the live tail,
    /// which ends a coasting flick.
    func agentScrolled(lines: Int) -> Bool {
        agentScrollDepth = max(0, agentScrollDepth + lines)
        followsTail = agentScrollDepth == 0
        return lines > 0 || agentScrollDepth > 0
    }

    func resetAgentScroll() {
        agentScrollDepth = 0
        followsTail = true
    }

    func jumpToTail() {
        // The agent owns that scroll: Ctrl+End is Claude's jump-to-latest shortcut,
        // the same lever the web terminal sends.
        if agentScrollDepth > 0, canSendInput { session.send(Data("\u{1b}[1;5F".utf8)) }
        resetAgentScroll()
        scrollToTail?()
    }

    func replayWillBegin() { resetAgentScroll() }

    private func reconcile() {
        let shouldAttach = visible && active && rendererReady
        guard shouldAttach != isAttached else { return }
        generation += 1
        isAttached = shouldAttach
        if shouldAttach {
            if reattachPending {
                reattachPending = false
                session.takeOver()
            }
            // Foreground entry creates a new attachment and replays scrollback too.
            // The core clears on a socket reattach; clear here for a fresh instance.
            switch session.phase {
            case .superseded, .ended: break
            case .idle, .connecting, .live:
                replayWillBegin()
                session.onClear?()
            }
            session.attach(cols: cols, rows: rows)
        } else {
            session.detach()
        }
    }
}
