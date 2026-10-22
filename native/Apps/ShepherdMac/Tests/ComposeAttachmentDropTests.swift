import AppKit
import SwiftUI
import Testing
import UniformTypeIdentifiers
@testable import Shepherd
@testable import ShepherdAppCore

extension MacSeamTests {
    @MainActor @Suite struct ComposeAttachmentDropTests {
        /// A Finder drag: its files sit on the drag pasteboard, which the text view reads on drop.
        final class FileDrag: NSObject, NSDraggingInfo {
            let draggingPasteboard = NSPasteboard(name: .drag)
            var location = NSPoint.zero
            @MainActor init(urls: [URL]) {
                super.init()
                draggingPasteboard.clearContents()
                draggingPasteboard.writeObjects(urls as [NSURL])
            }
            var draggingDestinationWindow: NSWindow? { nil }
            var draggingSourceOperationMask: NSDragOperation { .copy }
            var draggingLocation: NSPoint { location }
            var draggedImageLocation: NSPoint { location }
            var draggedImage: NSImage? { nil }
            var draggingSource: Any? { nil }
            var draggingSequenceNumber: Int { 1 }
            func slideDraggedImage(to screenPoint: NSPoint) {}
            var draggingFormation: NSDraggingFormation { get { .default } set {} }
            var animatesToDestination: Bool { get { false } set {} }
            var numberOfValidItemsForDrop: Int { get { 1 } set {} }
            func enumerateDraggingItems(options: NSDraggingItemEnumerationOptions, for view: NSView?, classes: [AnyClass],
                                        searchOptions: [NSPasteboard.ReadingOptionKey: Any],
                                        using block: (NSDraggingItem, Int, UnsafeMutablePointer<ObjCBool>) -> Void) {}
            var springLoadingHighlight: NSSpringLoadingHighlight { .none }
            func resetSpringLoading() {}
        }

        @MainActor struct Editor {
            let model: ComposeModel
            let attachments: AttachmentModel
            let window: NSWindow
            let textView: NSTextView
            let bridge: PromptAttachmentBridgeView

            func teardown() { window.orderOut(nil); window.contentView = nil; model.teardown() }
        }

        static func editor() async throws -> Editor {
            let attachments = AttachmentModel(upload: { _, name in "/staged/\(name)" })
            let model = ComposeModelTests.composer(attachments: attachments)
            model.repoBranches.allowsStatusProbe = false
            model.prompt = "Fix the badge"
            let host = NSHostingView(rootView: ComposePromptEditor(model: model).frame(width: 600))
            let window = NSWindow(contentRect: .init(x: -10000, y: -10000, width: 600, height: 400),
                                  styleMask: [.borderless], backing: .buffered, defer: false)
            window.contentView = host
            window.orderFront(nil)
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(150))
            func views<T: NSView>(_ kind: T.Type, in view: NSView) -> [T] {
                ((view as? T).map { [$0] } ?? []) + view.subviews.flatMap { views(kind, in: $0) }
            }
            let textView = try #require(views(NSTextView.self, in: host).first)
            let bridge = try #require(views(PromptAttachmentBridgeView.self, in: host).first)
            return Editor(model: model, attachments: attachments, window: window, textView: textView, bridge: bridge)
        }

        static func temporaryFile(_ name: String) throws -> URL {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID())-\(name)")
            try Data([0x89, 0x50, 0x4E, 0x47]).write(to: url)
            return url
        }

        @Test func droppedFilesBecomeAttachmentsNotPaths() async throws {
            let editor = try await Self.editor()
            defer { editor.teardown() }
            let files = try [Self.temporaryFile("Snapzy.png"), Self.temporaryFile("notes.txt")]
            defer { files.forEach { try? FileManager.default.removeItem(at: $0) } }
            #expect(editor.textView.delegate is PromptTextDelegate)

            // AppKit hands the drop to the text view, the deepest drop target under the pointer.
            let drag = FileDrag(urls: files)
            drag.location = editor.textView.convert(NSPoint(x: editor.textView.bounds.midX, y: editor.textView.bounds.midY), to: nil)
            _ = editor.textView.draggingEntered(drag)
            _ = editor.textView.draggingUpdated(drag)
            #expect(editor.textView.prepareForDragOperation(drag))
            #expect(editor.textView.performDragOperation(drag))
            editor.textView.concludeDragOperation(drag)
            try await Task.sleep(for: .milliseconds(100))

            #expect(editor.model.prompt == "Fix the badge")
            #expect(editor.attachments.rows.map(\.file.name) == files.map(\.lastPathComponent))
        }

        @Test func typedTextStillReachesThePrompt() async throws {
            let editor = try await Self.editor()
            defer { editor.teardown() }
            editor.window.makeFirstResponder(editor.textView)
            editor.textView.insertText(" now", replacementRange: NSRange(location: editor.textView.string.utf16.count, length: 0))
            try await Task.sleep(for: .milliseconds(100))
            #expect(editor.model.prompt == "Fix the badge now")
            #expect(editor.attachments.rows.isEmpty)
        }

        @Test func pastedImageBecomesAnAttachment() async throws {
            let editor = try await Self.editor()
            defer { editor.teardown() }
            let pasteboard = NSPasteboard(name: .init("ComposeAttachmentDropTests.\(UUID())"))
            let png = try #require(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 2, pixelsHigh: 2, bitsPerSample: 8, samplesPerPixel: 4,
                                                    hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)?
                .representation(using: .png, properties: [:]))
            pasteboard.clearContents()
            pasteboard.setData(png, forType: .png)
            editor.window.makeFirstResponder(editor.textView)
            let paste = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command, timestamp: 0,
                                                      windowNumber: editor.window.windowNumber, context: nil, characters: "v",
                                                      charactersIgnoringModifiers: "v", isARepeat: false, keyCode: 9))
            #expect(editor.bridge.intercept(paste, pasteboard: pasteboard) == nil)
            #expect(editor.attachments.rows.count == 1)
            #expect(editor.attachments.rows.first?.file.name.hasSuffix(".png") == true)
            #expect(editor.model.prompt == "Fix the badge")

            // Plain text keeps its native paste; the event passes through untouched.
            pasteboard.clearContents()
            pasteboard.setString("hello", forType: .string)
            #expect(editor.bridge.intercept(paste, pasteboard: pasteboard) === paste)
            #expect(editor.attachments.rows.count == 1)
        }

        @Test func onlyThePasteboardsOwnPathsCountAsDrops() throws {
            let file = try Self.temporaryFile("shot.png")
            defer { try? FileManager.default.removeItem(at: file) }
            let pasteboard = NSPasteboard(name: .init("ComposeAttachmentDropTests.\(UUID())"))
            pasteboard.clearContents()
            pasteboard.writeObjects([file as NSURL])
            #expect(PromptTextDelegate.droppedFiles(matching: file.path, pasteboards: [pasteboard]) == [file])
            #expect(PromptTextDelegate.droppedFiles(matching: "see \(file.path)", pasteboards: [pasteboard]) == nil)
            #expect(PromptTextDelegate.droppedFiles(matching: "/", pasteboards: [pasteboard]) == nil)
            pasteboard.clearContents()
            pasteboard.setString(file.path, forType: .string)
            #expect(PromptTextDelegate.droppedFiles(matching: file.path, pasteboards: [pasteboard]) == nil)
        }
    }
}
