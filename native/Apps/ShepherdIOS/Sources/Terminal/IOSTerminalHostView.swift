import ShepherdAppCore
import SwiftTerm
import SwiftUI
import UIKit

/// A watching surface: tapping the emulator never summons a keyboard.
/// Text entry and control keys live in explicit controls below it.
final class IOSWatchingTerminalView: SwiftTerm.TerminalView {
    var onUserScroll: (@MainActor (Double, Bool) -> Void)?
    override var canBecomeFirstResponder: Bool { false }
    override func accessibilityScroll(_ direction: UIAccessibilityScrollDirection) -> Bool {
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

struct IOSTerminalHostView: UIViewRepresentable {
    let model: IOSTerminalPresentation
    let fontSize: Double

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
        return view
    }

    func updateUIView(_ view: IOSWatchingTerminalView, context: Context) {
        if view.font.pointSize != CGFloat(fontSize) {
            view.font = .monospacedSystemFont(ofSize: CGFloat(fontSize), weight: .regular)
        }
    }

    static func dismantleUIView(_ view: IOSWatchingTerminalView, coordinator: Coordinator) {
        view.terminalDelegate = nil
        view.onUserScroll = nil
        coordinator.model.rendererUnmounted()
    }

    @MainActor
    final class Coordinator: NSObject, @MainActor TerminalViewDelegate {
        let model: IOSTerminalPresentation
        private var feedingOutput = false

        init(model: IOSTerminalPresentation) { self.model = model }

        func bind(_ view: IOSWatchingTerminalView) {
            view.onUserScroll = { [weak model] position, canScroll in
                model?.userScrolled(position: position, canScroll: canScroll)
            }
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
            }
            let terminal = view.getTerminal()
            model.rendererMounted(cols: terminal.cols, rows: terminal.rows)
        }

        func sizeChanged(source: SwiftTerm.TerminalView, newCols: Int, newRows: Int) {
            model.resize(cols: newCols, rows: newRows)
        }

        func send(source: SwiftTerm.TerminalView, data: ArraySlice<UInt8>) {
            // Only emulator protocol replies travel here. Touch navigation never sends
            // bytes, including SwiftTerm's alternate-buffer pan-to-arrow translation.
            guard feedingOutput else { return }
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
