import Foundation
import Observation

/// Debounces the `.connecting` overlay so a reattach that resolves within a
/// frame or two — the common case, since `.reattached` usually lands right
/// behind `.detached` — does not flash the "Connecting…" card over a terminal
/// that is otherwise still showing the last frame it painted.
///
/// Standalone from `TerminalSessionModel` and `TerminalPane` so the delay is
/// directly testable without a socket or a view.
@MainActor
@Observable
final class ConnectingOverlayDebouncer {
    private(set) var isVisible = false
    private let delay: Duration
    /// The pending "show it" timer. `@ObservationIgnored`: it is plumbing, not
    /// state anything renders.
    @ObservationIgnored
    private var pending: Task<Void, Never>?

    init(delay: Duration = .milliseconds(400)) {
        self.delay = delay
    }

    /// Call on every `TerminalSessionModel.phase` change with whether the new
    /// phase is `.connecting`.
    ///
    /// A phase that is not `.connecting` cancels the timer and hides the card
    /// immediately — `.live`, `.superseded` and `.ended` all paint their own
    /// content the instant they land, so there is nothing left to debounce.
    /// Idempotent while `.connecting` persists: a second call with `true`
    /// while a timer is already pending (or has already fired) neither
    /// restarts it nor re-arms it.
    func phaseChanged(toConnecting connecting: Bool) {
        guard connecting else {
            pending?.cancel()
            pending = nil
            isVisible = false
            return
        }
        guard pending == nil else { return }
        let delay = self.delay
        pending = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            self?.isVisible = true
        }
    }
}
