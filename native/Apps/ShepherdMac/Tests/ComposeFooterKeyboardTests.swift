import AppKit
import ShepherdKit
import SwiftUI
import Testing
@testable import Shepherd
@testable import ShepherdAppCore

extension MacSeamTests {
    @MainActor @Suite struct ComposeFooterKeyboardTests {
        @Test(arguments: [false, true])
        func returnInsertsNewlineAndCommandReturnSubmitsOnce(holdLikely: Bool) async throws {
            let model = ComposeModelTests.composer()
            model.repoBranches.allowsStatusProbe = false
            model.repoPath = "/repo"; model.prompt = "First line"
            var submissions: [Bool] = []
            let footer = ComposeFooter(readiness: model.readiness(repoResolved: true, holdLikely: holdLikely),
                repoName: "repo", branch: model.repoBranches, held: false, submit: { submissions.append($0) })
            let host = NSHostingView(rootView: VStack {
                TextEditor(text: Binding(get: { model.prompt }, set: { model.prompt = $0 })).frame(height: 100)
                footer
            }.padding())
            let window = NSWindow(contentRect: .init(x: -10000, y: -10000, width: 1040, height: 240),
                                  styleMask: [.titled], backing: .buffered, defer: false)
            window.contentView = host
            window.makeKeyAndOrderFront(nil)
            host.layoutSubtreeIfNeeded()
            defer { window.orderOut(nil); window.contentView = nil; model.teardown() }
            try await Task.sleep(for: .milliseconds(50))
            func textView(_ view: NSView) -> NSTextView? {
                (view as? NSTextView) ?? view.subviews.lazy.compactMap { textView($0) }.first
            }
            let editor = try #require(textView(host))
            #expect(window.makeFirstResponder(editor))
            editor.setSelectedRange(NSRange(location: editor.string.utf16.count, length: 0))
            func key(_ flags: NSEvent.ModifierFlags) throws -> NSEvent {
                try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags,
                    timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: "\r",
                    charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
            }
            let plainReturn = try key([])
            #expect(!window.performKeyEquivalent(with: plainReturn))
            editor.keyDown(with: plainReturn)
            #expect(editor.string == "First line\n")
            #expect(submissions.isEmpty)
            #expect(window.performKeyEquivalent(with: try key(.command)))
            #expect(submissions == [false])
        }
    }
}
