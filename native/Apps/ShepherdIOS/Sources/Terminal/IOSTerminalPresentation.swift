import Foundation
import Observation
import ShepherdAppCore

/// iOS owns visibility and scene suspension; the shared model owns the PTY.
/// A renderer must be mounted before attaching so the initial replay is never lost.
@MainActor
@Observable
final class IOSTerminalPresentation {
    let session: TerminalSessionModel
    private(set) var followsTail = true
    private(set) var isAttached = false
    @ObservationIgnored var scrollToTail: (@MainActor () -> Void)?
    private var visible = false
    private var active = false
    private var rendererReady = false
    private var cols = 80
    private var rows = 24

    init(session: TerminalSessionModel) { self.session = session }

    func visibilityChanged(visible: Bool, active: Bool) {
        self.visible = visible
        self.active = active
        reconcile()
    }

    func rendererMounted(cols: Int, rows: Int) {
        self.cols = max(1, cols)
        self.rows = max(1, rows)
        rendererReady = true
        reconcile()
    }

    func rendererUnmounted() {
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

    func jumpToTail() {
        followsTail = true
        scrollToTail?()
    }

    func replayWillBegin() { followsTail = true }

    private func reconcile() {
        let shouldAttach = visible && active && rendererReady
        guard shouldAttach != isAttached else { return }
        isAttached = shouldAttach
        if shouldAttach {
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
