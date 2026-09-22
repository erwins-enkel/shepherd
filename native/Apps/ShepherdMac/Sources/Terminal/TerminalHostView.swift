import ShepherdAppCore
import AppKit
import SwiftTerm
import SwiftUI

/// SwiftTerm's AppKit `TerminalView`, bound to a `TerminalSessionModel`.
///
/// Data flows both ways through the coordinator: SwiftTerm hands keystrokes to
/// `send(source:data:)`, and the model hands server bytes back through
/// `onOutput`. SwiftTerm computes cols/rows from its own bounds and reports them
/// via `sizeChanged`, which is what drives the resize control frame — the view
/// is the authority on size, never the model.
struct TerminalHostView: NSViewRepresentable {
    let model: TerminalSessionModel
    /// Read so a light/dark switch re-runs `updateNSView`: SwiftTerm resolves
    /// `NSColor.textColor` into fixed RGB when it is assigned, so a dynamic
    /// colour alone would freeze the terminal in whatever theme it was born in.
    @Environment(\.colorScheme) private var colorScheme

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    func makeNSView(context: Context) -> SwiftTerm.TerminalView {
        let view = SwiftTerm.TerminalView(frame: .init(x: 0, y: 0, width: 640, height: 400))
        view.terminalDelegate = context.coordinator
        view.font = Self.monospacedFont()
        // Claude Code turns mouse tracking on, which swallows drag-selection.
        // Option-drag is the standard escape hatch and must keep working.
        view.optionAsMetaKey = false
        // SwiftTerm's macOS view inherits NSView's ignored accessibility state.
        // Expose the hosted emulator, without claiming editable text semantics
        // that its custom terminal renderer does not implement.
        view.setAccessibilityElement(true)
        view.setAccessibilityRole(.group)
        view.setAccessibilityLabel(L.t("native_terminal_tab_title"))
        view.setAccessibilityIdentifier("terminal-view")
        context.coordinator.bind(view)
        return view
    }

    func updateNSView(_ view: SwiftTerm.TerminalView, context: Context) {
        context.coordinator.bind(view)
        // Follow the app appearance: a light-mode window with a black terminal
        // reads as broken, not as a theme. Resolving inside the view's own
        // drawing appearance is what turns the dynamic system colours into the
        // right pair of RGB values.
        view.effectiveAppearance.performAsCurrentDrawingAppearance {
            view.configureNativeColors()
        }
    }

    /// Releases the model's hold on a view that is going away. Without it the
    /// model would keep feeding bytes into a dead emulator for as long as the
    /// session lives.
    static func dismantleNSView(_ view: SwiftTerm.TerminalView, coordinator: Coordinator) {
        view.terminalDelegate = nil
        coordinator.unbind()
    }

    /// JetBrains Mono when the operator has it installed, otherwise the system
    /// monospace face. Never a hard-coded fallback name that may not exist.
    static func monospacedFont(size: CGFloat = 12) -> NSFont {
        NSFont(name: "JetBrains Mono", size: size)
            ?? NSFont.monospacedSystemFont(ofSize: size, weight: .regular)
    }

    /// `@MainActor TerminalViewDelegate` is an *isolated conformance*
    /// (SE-0470): SwiftTerm builds in Swift 5 language mode, so its delegate
    /// requirements are non-isolated, and a plain conformance from a main-actor
    /// class is a strict-concurrency error. The isolated spelling states the
    /// truth — every callback arrives on the main thread, because the caller is
    /// an `NSView` — without the `@preconcurrency` escape hatch this app bans.
    @MainActor
    final class Coordinator: NSObject, @MainActor TerminalViewDelegate {
        private let model: TerminalSessionModel
        private weak var view: SwiftTerm.TerminalView?
        /// The last size handed to the model. SwiftTerm reports `sizeChanged`
        /// on layout passes that did not change the grid, and every forwarded
        /// call is a control frame on the wire.
        private var lastSize: (cols: Int, rows: Int)?

        init(model: TerminalSessionModel) {
            self.model = model
            super.init()
        }

        /// Idempotent: `updateNSView` runs on every SwiftUI pass, and re-binding
        /// the same view must not stack duplicate output closures.
        func bind(_ view: SwiftTerm.TerminalView) {
            guard self.view !== view else { return }
            self.view = view
            // `[weak view]`: the model outlives this view — it belongs to
            // `TerminalController` — and a strong capture would keep a dead
            // emulator alive for the rest of the session.
            model.onOutput = { [weak view] bytes in
                view?.feed(byteArray: ArraySlice(bytes))
            }
            model.onClear = { [weak view] in
                guard let view else { return }
                // The server replays the scrollback on attach; wipe first.
                view.getTerminal().resetToInitialState()
            }
            let terminal = view.getTerminal()
            lastSize = (terminal.cols, terminal.rows)
            model.attach(cols: terminal.cols, rows: terminal.rows)
        }

        /// Drops both sides of the binding. Called from `dismantleNSView`.
        func unbind() {
            model.onOutput = nil
            model.onClear = nil
            view = nil
            lastSize = nil
        }

        // MARK: TerminalViewDelegate

        func send(source: SwiftTerm.TerminalView, data: ArraySlice<UInt8>) {
            model.send(Data(data))
        }

        func sizeChanged(source: SwiftTerm.TerminalView, newCols: Int, newRows: Int) {
            guard lastSize?.cols != newCols || lastSize?.rows != newRows else { return }
            lastSize = (newCols, newRows)
            model.resize(cols: newCols, rows: newRows)
        }

        func clipboardCopy(source: SwiftTerm.TerminalView, content: Data) {
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            pasteboard.setString(String(decoding: content, as: UTF8.self), forType: .string)
        }

        func requestOpenLink(
            source: SwiftTerm.TerminalView, link: String, params: [String: String]
        ) {
            // Only the two web schemes: an agent's output is untrusted text, and
            // `file:` or a custom scheme would hand it an app launcher.
            guard let url = URL(string: link), url.scheme == "http" || url.scheme == "https" else {
                return
            }
            NSWorkspace.shared.open(url)
        }

        func scrolled(source: SwiftTerm.TerminalView, position: Double) {}
        func setTerminalTitle(source: SwiftTerm.TerminalView, title: String) {}
        func rangeChanged(source: SwiftTerm.TerminalView, startY: Int, endY: Int) {}
        func bell(source: SwiftTerm.TerminalView) {}
        func iTermContent(source: SwiftTerm.TerminalView, content: ArraySlice<UInt8>) {}
        func hostCurrentDirectoryUpdate(source: SwiftTerm.TerminalView, directory: String?) {}
    }
}
