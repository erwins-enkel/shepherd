import ShepherdAppCore
import SwiftTerm
import SwiftUI
import UIKit

/// A watching surface: tapping the emulator never summons a keyboard.
/// Text entry and control keys live in explicit controls below it.
final class IOSWatchingTerminalView: SwiftTerm.TerminalView {
    var onUserScroll: (@MainActor (Double, Bool) -> Void)?
    /// Whether wheel input may reach the agent now: a live attachment that permits input.
    var canForwardWheel: (@MainActor () -> Bool)?
    /// Forwards wheel lines (positive reveals older output); false ends a coasting flick.
    var onWheel: (@MainActor (Int) -> Bool)?
    var onAgentScrollEnded: (@MainActor () -> Void)?
    private var wheelPan: UIPanGestureRecognizer?
    private var wheel = IOSTerminalWheel(lineHeight: 1)
    private var momentum: Task<Void, Never>?
    override var canBecomeFirstResponder: Bool { false }

    /// Claude Code tracks the mouse and repaints its own scrolled transcript, so local
    /// history cannot move it.
    var agentOwnsScroll: Bool { getTerminal().mouseMode != .off }
    /// Vertical swipes then become wheel input for the agent, as on the web and Mac.
    /// Everything else keeps SwiftTerm's local scrolling.
    var forwardsSwipesToAgent: Bool { agentOwnsScroll && canForwardWheel?() == true }

    func installWheelScroll() {
        guard wheelPan == nil else { return }
        let pan = UIPanGestureRecognizer(target: self, action: #selector(wheelPanned(_:)))
        pan.maximumNumberOfTouches = 1
        addGestureRecognizer(pan)
        wheelPan = pan
    }

    /// One wheel report per line through SwiftTerm's encoder, so the app's chosen mouse
    /// protocol (SGR for Claude Code) is honoured. Reported at the grid centre.
    func sendWheel(lines: Int) {
        let terminal = getTerminal()
        let flags = terminal.encodeButton(button: lines > 0 ? 4 : 5, release: false,
            shift: false, meta: false, control: false)
        for _ in 0..<abs(lines) {
            terminal.sendEvent(buttonFlags: flags, x: terminal.cols / 2, y: terminal.rows / 2)
        }
    }

    func stopWheelMomentum() {
        momentum?.cancel()
        momentum = nil
        wheel.stop()
    }

    // SwiftTerm adds a mouse pan recognizer while the app tracks the mouse. With mouse
    // reporting off its handler does nothing, yet it still competes with scrolling.
    override func mouseModeChanged(source: SwiftTerm.Terminal) {
        guard source.mouseMode == .off else { return }
        // Cancel a drag in flight: the program that takes over must not receive wheel reports.
        if let wheelPan, wheelPan.state != .possible {
            wheelPan.isEnabled = false
            wheelPan.isEnabled = true
        }
        stopWheelMomentum()
        onAgentScrollEnded?()
    }

    override func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
        if let wheelPan, recognizer === wheelPan {
            let velocity = wheelPan.velocity(in: self)
            return forwardsSwipesToAgent && abs(velocity.y) > abs(velocity.x)
        }
        if recognizer === panGestureRecognizer, forwardsSwipesToAgent { return false }
        return super.gestureRecognizerShouldBegin(recognizer)
    }

    // A fresh touch catches the coast, like grabbing a moving page.
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        stopWheelMomentum()
        super.touchesBegan(touches, with: event)
    }

    override func willMove(toWindow newWindow: UIWindow?) {
        super.willMove(toWindow: newWindow)
        if newWindow == nil { stopWheelMomentum() }
    }

    @objc private func wheelPanned(_ pan: UIPanGestureRecognizer) {
        switch pan.state {
        case .began:
            stopWheelMomentum()
            wheel = IOSTerminalWheel(lineHeight: font.lineHeight)
        case .changed:
            let lines = wheel.drag(by: pan.translation(in: self).y)
            pan.setTranslation(.zero, in: self)
            if lines != 0 { _ = onWheel?(lines) }
        case .ended:
            wheel.release(velocity: pan.velocity(in: self).y)
            coast()
        default:
            stopWheelMomentum()
        }
    }

    private func coast() {
        guard wheel.velocity != 0 else { return }
        momentum?.cancel()
        momentum = Task { @MainActor [weak self] in
            var last = ContinuousClock.now
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(16))
                guard !Task.isCancelled, let self else { return }
                let now = ContinuousClock.now
                let lines = self.wheel.coast(dt: (now - last) / .seconds(1))
                last = now
                guard let lines else { return }
                if lines != 0, self.onWheel?(lines) != true {
                    self.wheel.stop()
                    return
                }
            }
        }
    }

    override func accessibilityScroll(_ direction: UIAccessibilityScrollDirection) -> Bool {
        if forwardsSwipesToAgent {
            let page = getTerminal().rows
            switch direction {
            case .up, .previous: _ = onWheel?(page)
            case .down, .next: _ = onWheel?(-page)
            default: return false
            }
            UIAccessibility.post(notification: .pageScrolled, argument: nil)
            return true
        }
        guard canScroll else { return false }
        let scrolled = super.accessibilityScroll(direction)
        if scrolled {
            // SwiftTerm's contentOffset sync freezes history only for finger tracking.
            // VoiceOver has no tracking gesture: explicitly update its display row too.
            let maximumOffset = max(1, contentSize.height - bounds.height)
            scroll(toPosition: Double(contentOffset.y / maximumOffset))
            onUserScroll?(scrollPosition, canScroll)
        }
        return scrolled
    }
    override var contentOffset: CGPoint {
        didSet {
            if isTracking || isDecelerating {
                onUserScroll?(scrollPosition, canScroll)
            }
        }
    }
}

/// A horizontal swipe across the output. Vertical scrolling stays the emulator's.
enum IOSHorizontalPan: Equatable {
    case changed(CGFloat)
    case ended(translation: CGFloat, velocity: CGFloat)
    case cancelled
}

struct IOSTerminalHostView: UIViewRepresentable {
    let model: IOSTerminalPresentation
    let fontSize: Double
    var onHorizontalPan: (@MainActor (IOSHorizontalPan) -> Void)?
    var onDoubleTap: (@MainActor () -> Void)?

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    func makeUIView(context: Context) -> IOSWatchingTerminalView {
        let view = IOSWatchingTerminalView(frame: .init(x: 0, y: 0, width: 390, height: 500),
            font: .monospacedSystemFont(ofSize: CGFloat(fontSize), weight: .regular))
        view.terminalDelegate = context.coordinator
        view.nativeBackgroundColor = IOSTerminalStyle.nativeBackground
        view.nativeForegroundColor = IOSTerminalStyle.nativeInk
        view.backgroundColor = IOSTerminalStyle.nativeBackground
        view.allowMouseReporting = false
        view.inputAccessoryView = nil
        view.accessibilityLabel = L.t("native_terminal_tab_title")
        view.accessibilityHint = L.t("native_ios_terminal_hint")
        view.accessibilityIdentifier = "terminal-view"
        context.coordinator.bind(view)
        context.coordinator.onHorizontalPan = onHorizontalPan
        context.coordinator.onDoubleTap = onDoubleTap
        let doubleTap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.doubleTapped))
        doubleTap.numberOfTapsRequired = 2
        doubleTap.delegate = context.coordinator
        view.addGestureRecognizer(doubleTap)
        let pan = UIPanGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.horizontalPan(_:)))
        pan.delegate = context.coordinator
        view.addGestureRecognizer(pan)
        return view
    }

    func updateUIView(_ view: IOSWatchingTerminalView, context: Context) {
        context.coordinator.onHorizontalPan = onHorizontalPan
        context.coordinator.onDoubleTap = onDoubleTap
        if view.font.pointSize != CGFloat(fontSize) {
            view.font = .monospacedSystemFont(ofSize: CGFloat(fontSize), weight: .regular)
        }
    }

    static func dismantleUIView(_ view: IOSWatchingTerminalView, coordinator: Coordinator) {
        view.terminalDelegate = nil
        view.onUserScroll = nil
        view.canForwardWheel = nil
        view.onWheel = nil
        view.onAgentScrollEnded = nil
        view.stopWheelMomentum()
        coordinator.cancelScreenScan()
        coordinator.model.rendererUnmounted()
        view.updateUiClosed()
    }

    @MainActor
    final class Coordinator: NSObject, @MainActor TerminalViewDelegate, UIGestureRecognizerDelegate {
        let model: IOSTerminalPresentation
        var onHorizontalPan: (@MainActor (IOSHorizontalPan) -> Void)?
        var onDoubleTap: (@MainActor () -> Void)?
        private var feedingOutput = false
        private var forwardingWheel = false
        private var screenScan: Task<Void, Never>?
        private var screenScanDeadline: ContinuousClock.Instant?

        @objc func doubleTapped() { onDoubleTap?() }

        @objc func horizontalPan(_ pan: UIPanGestureRecognizer) {
            let dx = pan.translation(in: pan.view).x
            switch pan.state {
            case .changed: onHorizontalPan?(.changed(dx))
            case .ended: onHorizontalPan?(.ended(translation: dx, velocity: pan.velocity(in: pan.view).x))
            case .cancelled, .failed: onHorizontalPan?(.cancelled)
            default: break
            }
        }

        /// Only a clearly sideways start is a swipe; anything else stays a scroll.
        func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
            if recognizer is UITapGestureRecognizer { return onDoubleTap != nil }
            guard onHorizontalPan != nil, let pan = recognizer as? UIPanGestureRecognizer else { return false }
            let velocity = pan.velocity(in: pan.view)
            return abs(velocity.x) > abs(velocity.y) * 1.5
        }

        func gestureRecognizer(_ recognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

        init(model: IOSTerminalPresentation) { self.model = model }

        func bind(_ view: IOSWatchingTerminalView) {
            view.onUserScroll = { [weak model] position, canScroll in
                model?.userScrolled(position: position, canScroll: canScroll)
            }
            view.canForwardWheel = { [weak model] in model?.canSendInput == true }
            view.onWheel = { [weak self, weak view] lines in
                guard let self, let view else { return false }
                return self.forwardWheel(view, lines: lines)
            }
            view.onAgentScrollEnded = { [weak model] in model?.resetAgentScroll() }
            view.installWheelScroll()
            model.scrollToTail = { [weak view] in view?.scroll(toPosition: 1) }
            model.session.onClear = { [weak view, weak model] in
                view?.getTerminal().resetToInitialState()
                model?.replayWillBegin()
                view?.scroll(toPosition: 1)
            }
            model.session.onOutput = { [weak self, weak view] bytes in
                guard let self, let view else { return }
                // SwiftTerm preserves its own userScrolling/yDisp while feeding output.
                // Forcing scroll-to-bottom here would fight finger tracking and momentum.
                self.feedingOutput = true
                view.feed(byteArray: ArraySlice(bytes))
                self.feedingOutput = false
                self.scheduleScreenScan(view)
            }
            let terminal = view.getTerminal()
            model.rendererMounted(cols: terminal.cols, rows: terminal.rows)
        }

        /// Rows are read once output pauses, and at most half a second behind streaming output,
        /// so a repaint split across chunks cannot flicker the bottom bar.
        private func scheduleScreenScan(_ view: IOSWatchingTerminalView) {
            let now = ContinuousClock.now
            let deadline = screenScanDeadline ?? now + .milliseconds(500)
            screenScan?.cancel()
            guard now < deadline else {
                screenScanDeadline = nil
                scanScreen(view)
                return
            }
            screenScanDeadline = deadline
            let delay = min(.milliseconds(120), deadline - now)
            screenScan = Task { @MainActor [weak self, weak view] in
                try? await Task.sleep(for: delay)
                guard !Task.isCancelled, let self, let view else { return }
                self.screenScanDeadline = nil
                self.scanScreen(view)
            }
        }

        func cancelScreenScan() {
            screenScan?.cancel()
            screenScan = nil
            screenScanDeadline = nil
        }

        private func scanScreen(_ view: IOSWatchingTerminalView) {
            // getLine is display-relative: local history on screen is not the live dialog.
            if !view.agentOwnsScroll, view.canScroll, view.scrollPosition < 1 { return }
            let terminal = view.getTerminal()
            model.screenChanged((0..<terminal.rows).map {
                terminal.getLine(row: $0)?.translateToString(trimRight: true) ?? ""
            })
        }

        func sizeChanged(source: SwiftTerm.TerminalView, newCols: Int, newRows: Int) {
            model.resize(cols: newCols, rows: newRows)
        }

        /// The one gesture that reaches the agent: it owns its transcript scroll while it
        /// tracks the mouse.
        private func forwardWheel(_ view: IOSWatchingTerminalView, lines: Int) -> Bool {
            guard view.agentOwnsScroll, model.canSendInput else { return false }
            forwardingWheel = true
            view.sendWheel(lines: lines)
            forwardingWheel = false
            return model.agentScrolled(lines: lines)
        }

        func send(source: SwiftTerm.TerminalView, data: ArraySlice<UInt8>) {
            // Only emulator protocol replies and agent-owned wheel scrolling travel here.
            // Taps, selection and SwiftTerm's alternate-buffer pan-to-arrow translation
            // never send bytes.
            guard feedingOutput || forwardingWheel else { return }
            model.session.send(Data(data))
        }

        func scrolled(source: SwiftTerm.TerminalView, position: Double) {
            if source.isTracking || source.isDecelerating {
                model.userScrolled(position: position, canScroll: source.canScroll)
            }
        }
        func requestOpenLink(source: SwiftTerm.TerminalView, link: String, params: [String: String]) {
            guard let url = URL(string: link), ["https", "http"].contains(url.scheme) else { return }
            UIApplication.shared.open(url)
        }
        func setTerminalTitle(source: SwiftTerm.TerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: SwiftTerm.TerminalView, directory: String?) {}
        func bell(source: SwiftTerm.TerminalView) {}
        func clipboardCopy(source: SwiftTerm.TerminalView, content: Data) {}
        func rangeChanged(source: SwiftTerm.TerminalView, startY: Int, endY: Int) {}
        func iTermContent(source: SwiftTerm.TerminalView, content: ArraySlice<UInt8>) {}
    }
}
