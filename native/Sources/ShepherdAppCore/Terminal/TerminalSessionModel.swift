import Foundation
import Observation
import ShepherdKit

/// One attached terminal's UI state: owns the socket, fans output out to the
/// SwiftTerm view, and runs the prompt bar's `/reply` call.
///
/// Every async completion re-checks `generation`, which `attach`/`detach` bump.
/// A reply that resolves after the operator switched sessions (or the store was
/// torn down) must not paint an error over the fresh attach.
@Observable
@MainActor
public final class TerminalSessionModel {
    /// `.ended` is terminal; `.superseded` is recoverable via `takeOver()`.
    public enum Phase: Equatable {
        case idle
        case connecting
        case live
        case superseded
        case ended(PTYConnection.Closure)
    }

    public private(set) var phase: Phase = .idle
    /// The prompt bar's text, two-way bound by the view.
    public var promptText: String = ""
    public private(set) var promptBusy = false
    public private(set) var promptError: String?
    public private(set) var recoveryFailure: BackendFailure = .undetermined
    private let recovery: BackendRecoveryModel?
    private var recoveryTask: Task<Void, Never>?

    /// Set by the SwiftTerm view: raw bytes to feed the emulator. Anything that
    /// arrives before it is set is buffered, because the first bytes of an
    /// attach are the replayed scrollback.
    ///
    /// Explicitly `@MainActor` in the closure type: the view that assigns it is
    /// main-actor isolated, and a bare `((Data) -> Void)?` would need a
    /// non-isolated conversion that Swift 6 rejects at the assignment.
    ///
    /// `@ObservationIgnored` because the observation macro rewrites a tracked
    /// stored property into accessors, which cannot carry a `didSet` — and
    /// because a view's own callback is plumbing, not state anything observes.
    @ObservationIgnored
    public var onOutput: (@MainActor (Data) -> Void)? {
        didSet {
            guard onOutput != nil, !pendingOutput.isEmpty else { return }
            let buffered = pendingOutput
            pendingOutput = []
            for chunk in buffered { onOutput?(chunk) }
        }
    }
    /// Set by the SwiftTerm view: wipe the emulator's buffer. Called on every
    /// reattach, because the server replays the scrollback and appending would
    /// double every line.
    @ObservationIgnored
    public var onClear: (@MainActor () -> Void)?

    let sessionID: String
    let allowsInput: Bool

    public private(set) var sessionRecoveryBusy = false
    public private(set) var sessionRecoveryError: String?
    private let readSession: @MainActor () async throws -> Session
    private let resumeSession: @MainActor () async throws -> Void
    private let reloadSessions: @MainActor () async throws -> Void

    private let reply: @Sendable (String) async throws -> Void
    private let makeAttachment: @MainActor (Int, Int) -> any PTYAttaching
    private var attachment: (any PTYAttaching)?
    private var pumps: [Task<Void, Never>] = []
    private var pendingOutput: [Data] = []
    private var cols = 100
    private var rows = 30
    private var generation = 0
    /// The verdict a previous attach ended on, held across `detach()`.
    ///
    /// Without it a tab switch would re-attach behind the operator's back: a
    /// `.superseded` terminal would bump whoever took it over, and an
    /// `.ended(.gone)` one would spin on a session that has no agent left.
    /// Only `takeOver()` clears it, because only the operator can decide to
    /// reclaim the terminal.
    private var parked: Phase?

    init(
        sessionID: String,
        allowsInput: Bool = true,
        recovery: BackendRecoveryModel? = nil,
        readSession: @escaping @MainActor () async throws -> Session = { throw ShepherdError.notFound },
        resumeSession: @escaping @MainActor () async throws -> Void = {},
        reloadSessions: @escaping @MainActor () async throws -> Void = {},
        reply: @escaping @Sendable (String) async throws -> Void,
        makeAttachment: @escaping @MainActor (Int, Int) -> any PTYAttaching
    ) {
        self.readSession = readSession
        self.resumeSession = resumeSession
        self.reloadSessions = reloadSessions
        self.recovery = recovery
        self.sessionID = sessionID
        self.allowsInput = allowsInput
        self.reply = reply
        self.makeAttachment = makeAttachment
    }

    /// The app's wiring: reply through the store's client, attach over a real
    /// socket.
    public convenience init(sessionID: String, store: SessionStore, allowsInput: Bool = true, recovery: BackendRecoveryModel? = nil) {
        let client = store.client
        self.init(
            sessionID: sessionID,
            allowsInput: allowsInput,
            recovery: recovery,
            readSession: { try await client.session(id: sessionID) },
            resumeSession: { _ = try await client.resume(sessionID: sessionID) },
            reloadSessions: { try await store.refresh() },
            reply: { text in try await client.replySession(id: sessionID, text: text) },
            makeAttachment: { cols, rows in
                LivePTYAttachment(client: client, sessionID: sessionID, cols: cols, rows: rows)
            })
    }

    /// Open the socket at the view's current size. Idempotent while attached: a
    /// second call only updates the size.
    public func attach(cols: Int, rows: Int) {
        self.cols = max(cols, 1)
        self.rows = max(rows, 1)
        if let attachment {
            attachment.resize(cols: self.cols, rows: self.rows)
            return
        }
        if let parked {
            // The socket is gone, but so is the reason to open another one.
            phase = parked
            return
        }
        generation += 1
        let generation = self.generation
        let attachment = makeAttachment(self.cols, self.rows)
        self.attachment = attachment
        phase = .connecting
        pumps = [
            Task { [weak self] in
                for await bytes in attachment.output {
                    guard let self, self.generation == generation else { return }
                    self.deliver(bytes)
                }
            },
            Task { [weak self] in
                for await event in attachment.lifecycle {
                    guard let self, self.generation == generation else { return }
                    self.apply(event)
                }
            },
        ]
        attachment.start()
    }

    /// Close the socket and drop the pumps. Bumps the generation, so anything
    /// still in flight is discarded when it lands.
    ///
    /// A verdict (`.superseded` or either `.ended`) is remembered rather than
    /// cleared: the next `attach()` restores it instead of opening a second
    /// socket.
    public func detach() {
        recoveryTask?.cancel(); recoveryTask = nil
        generation += 1
        for pump in pumps { pump.cancel() }
        pumps = []
        switch phase {
        case .superseded, .ended: parked = phase
        case .idle, .connecting, .live: parked = nil
        }
        attachment?.stop()
        attachment = nil
        pendingOutput = []
        phase = parked ?? .idle
        // The busy gate belongs to the generation that opened it: an in-flight
        // reply now lands on the stale branch of `submitPrompt` and clears
        // nothing, so leaving it set would lock the prompt bar for good.
        promptBusy = false
        promptError = nil
        sessionRecoveryBusy = false
        sessionRecoveryError = nil
    }

    /// Re-attach on the operator's say-so. Keeps the same attachment, so the
    /// existing pumps stay valid.
    ///
    /// Gone sessions use `recoverGoneSession()` first; opening the same missing
    /// PTY without an authoritative read and successful resume cannot recover it.
    public func takeOver() {
        guard allowsInput else { return }
        parked = nil
        guard let attachment else {
            // `detach()` dropped the socket while the verdict stood. The
            // operator asked for the terminal back, so open a new one.
            attach(cols: cols, rows: rows)
            return
        }
        phase = .connecting
        attachment.takeOver()
    }

    /// Explicit operator recovery, distinct from reclaiming a superseded socket.
    /// Reuse the Action Bar's resume eligibility and API; never spawn on a close frame.
    public func recoverGoneSession() async {
        guard allowsInput, phase == .ended(.gone), !sessionRecoveryBusy else { return }
        let mine = generation
        sessionRecoveryBusy = true
        sessionRecoveryError = nil
        defer { if generation == mine { sessionRecoveryBusy = false } }
        func current() -> Bool { generation == mine && !Task.isCancelled }
        do {
            let session: Session
            do { session = try await readSession() }
            catch ShepherdError.notFound {
                guard current() else { return }
                try await reloadSessions()
                guard current() else { return }
                sessionRecoveryError = L.t("native_terminal_session_unavailable")
                return
            }
            guard current() else { return }
            if session.status.known == .archived {
                try await reloadSessions()
                guard current() else { return }
                sessionRecoveryError = L.t("native_terminal_session_unavailable")
                return
            }
            guard ActionRules.allows(.resume, session: session,
                now: Int(Date().timeIntervalSince1970 * 1000)) else {
                sessionRecoveryError = L.t("native_terminal_session_not_resumable")
                return
            }
            try await resumeSession()
            guard current() else { return }
            takeOver()
        } catch {
            guard current() else { return }
            sessionRecoveryError = L.t("native_terminal_recovery_failed", ShepherdErrorCopy.message(error))
        }
    }

    public func send(_ bytes: Data) {
        // SwiftTerm also calls this for device-status/cursor queries in replayed output.
        // Suppress all input during isolated live smoke, including those automatic replies.
        guard allowsInput else { return }
        attachment?.send(bytes)
    }

    public func resize(cols: Int, rows: Int) {
        guard cols > 0, rows > 0 else { return }
        self.cols = cols
        self.rows = rows
        attachment?.resize(cols: cols, rows: rows)
    }

    /// Send the prompt bar's text through `/reply`.
    ///
    /// The field clears optimistically so the operator can keep typing, and is
    /// restored verbatim on failure — retyping a paragraph because the agent's
    /// pane had just died is the worst outcome available here.
    public func submitPrompt() async {
        guard allowsInput else { return }
        let text = promptText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !promptBusy else { return }
        let generation = self.generation
        promptBusy = true
        promptError = nil
        promptText = ""
        do {
            try await reply(text)
            guard self.generation == generation else { return }
            promptBusy = false
        } catch {
            guard self.generation == generation else { return }
            promptBusy = false
            promptText = text
            promptError = L.t("native_terminal_prompt_failed", ShepherdErrorCopy.message(error))
        }
    }

    private func deliver(_ bytes: Data) {
        guard let onOutput else {
            pendingOutput.append(bytes)
            return
        }
        onOutput(bytes)
    }

    private func apply(_ event: PTYConnection.LifecycleEvent) {
        switch event {
        case .attached:
            phase = .live
        case .reattached:
            // The scrollback is replayed on every attach: clear before it lands.
            pendingOutput = []
            onClear?()
            phase = .live
            attachment?.resize(cols: cols, rows: rows)
        case .detached:
            phase = .connecting
        case .closed(.superseded):
            phase = .superseded
        case .closed(.stopped):
            // `stop()` is terminal for an attachment instance: drop it so the
            // next `attach()` builds a fresh one rather than re-`start()`ing a
            // socket that has already closed itself.
            attachment = nil
            parked = nil
            phase = .idle
        case .closed(let closure):
            phase = .ended(closure)
            recoveryFailure = BackendRecovery.classify(serverReachable: nil, diagnostics: nil, closure: closure)
            if closure == .unreachable, let recovery {
                let mine = generation
                recoveryTask?.cancel()
                recoveryTask = Task { [weak self] in
                    await recovery.refresh()
                    guard let self, self.generation == mine, self.phase == .ended(.unreachable),
                          !Task.isCancelled else { return }
                    self.recoveryFailure = recovery.diagnosis(for: closure)
                }
            }
        }
    }
}
