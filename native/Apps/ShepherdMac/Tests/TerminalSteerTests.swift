import AppKit
import ShepherdKit
import SwiftTerm
import Testing
@testable import Shepherd
@testable import ShepherdAppCore

extension MacSeamTests {
    @MainActor
    struct TerminalSteerTests {
        @Test(arguments: [false, true])
        func directTypingReachesPTYUnlessIsolated(allowsInput: Bool) throws {
            let attachment = FakeAttachment()
            let model = TerminalSessionModel(sessionID: "s1", allowsInput: allowsInput,
                reply: { _ in Issue.record("Direct typing must use the PTY") },
                makeAttachment: { _, _ in attachment })
            let view = SwiftTerm.TerminalView(frame: .init(x: 0, y: 0, width: 640, height: 400))
            let coordinator = TerminalHostView.Coordinator(model: model)
            view.terminalDelegate = coordinator
            coordinator.bind(view)
            defer { view.terminalDelegate = nil; coordinator.unbind(); model.detach() }
            let key = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero,
                modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil,
                characters: "x", charactersIgnoringModifiers: "x", isARepeat: false, keyCode: 7))
            view.keyDown(with: key)
            #expect(attachment.sent == (allowsInput ? [Data("x".utf8)] : []))
        }

        @Test func mountingTerminalRequestsKeyboardFocus() async {
            let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 640, height: 400),
                styleMask: [.titled], backing: .buffered, defer: false)
            let view = FocusedTerminalView(frame: .init(x: 0, y: 0, width: 640, height: 400))
            window.contentView = view
            for _ in 0..<100 {
                if window.firstResponder === view { break }
                await Task.yield()
            }
            #expect(window.firstResponder === view)
            let attachment = FakeAttachment()
            let model = TerminalSessionModel(sessionID: "s1", reply: { _ in },
                makeAttachment: { _, _ in attachment })
            let coordinator = TerminalHostView.Coordinator(model: model)
            coordinator.bind(view)
            model.detach()
            #expect(window.makeFirstResponder(nil))
            #expect(window.firstResponder !== view)
            coordinator.requestKeyboardFocus(view, sequence: 1)
            for _ in 0..<100 {
                if window.firstResponder === view { break }
                await Task.yield()
            }
            #expect(window.firstResponder === view)
            #expect(attachment.startCount == 2)
            coordinator.unbind()
            model.detach()
            window.contentView = nil
        }

        @Test func steerShortcutsDoNotCollideWithMenus() {
            resetStreamSeams()
            defer { resetStreamSeams() }
            MacStreamHost.configure()
            StreamRegistrations.installScene()
            let shortcuts = MenuCommand.Menu.allCases.flatMap { CommandRegistry.commands(in: $0) }.compactMap(\.shortcut)
            for key in "123456789j" { #expect(!shortcuts.contains(.init(key))) }
            #expect(shortcuts.contains(.init("k")))
        }
    }
}
