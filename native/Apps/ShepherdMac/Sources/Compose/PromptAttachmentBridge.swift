import AppKit
import ShepherdAppCore
import SwiftUI
import UniformTypeIdentifiers

/// The AppKit text view behind `TextEditor` takes Finder drops and ⌘V before SwiftUI sees them:
/// a dropped or pasted file lands in the prompt as its path and a pasted image goes nowhere, so
/// neither reaches the composer's drop and paste handlers. Sitting behind the editor, this finds
/// that text view and routes files and images to the attachment queue instead.
struct PromptAttachmentBridge: NSViewRepresentable {
    let model: AttachmentModel

    func makeNSView(context: Context) -> PromptAttachmentBridgeView { PromptAttachmentBridgeView(model: model) }
    func updateNSView(_ view: PromptAttachmentBridgeView, context: Context) {
        view.model = model
        view.attachSoon()
    }
}

@MainActor
final class PromptAttachmentBridgeView: NSView {
    var model: AttachmentModel
    private let delegate = PromptTextDelegate()
    private var keyMonitor: Any?
    private(set) weak var textView: NSTextView?

    init(model: AttachmentModel) {
        self.model = model
        super.init(frame: .zero)
        delegate.attach = { [weak self] urls in self?.model.addFiles(urls) }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
            if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
            keyMonitor = nil
        } else {
            attachSoon()
        }
    }

    /// SwiftUI adds the editor's text view in the same pass as this view; look once it has.
    func attachSoon() {
        DispatchQueue.main.async { [weak self] in self?.attach() }
    }

    private func attach() {
        guard window != nil, let textView = textView ?? Self.textView(near: self) else { return }
        self.textView = textView
        // SwiftUI may hand the text view a fresh coordinator; wrap whichever delegate is current.
        if textView.delegate !== delegate {
            delegate.original = textView.delegate
            textView.delegate = delegate
        }
        if keyMonitor == nil {
            keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                let consumed = MainActor.assumeIsolated { self?.intercept(event) == nil }
                return consumed ? nil : event
            }
        }
    }

    /// ⌘V in the prompt with an image on the clipboard: the text view would discard it.
    func intercept(_ event: NSEvent, pasteboard: NSPasteboard = .general) -> NSEvent? {
        guard event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting(.capsLock) == .command,
              event.charactersIgnoringModifiers == "v",
              let textView, event.window === textView.window, textView.window?.firstResponder === textView,
              let image = Self.pastedImage(pasteboard) else { return event }
        model.addFiles([image])
        return nil
    }

    /// Text and files keep their native handling: text is pasted, a file arrives as a drop would.
    static func pastedImage(_ pasteboard: NSPasteboard) -> AttachmentModel.File? {
        guard !pasteboard.canReadObject(forClasses: [NSString.self], options: nil),
              !pasteboard.canReadObject(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) else { return nil }
        let png: Data?
        if let data = pasteboard.data(forType: .png) { png = data }
        else { png = pasteboard.data(forType: .tiff).flatMap { NSBitmapImageRep(data: $0)?.representation(using: .png, properties: [:]) } }
        guard let png else { return nil }
        return .init(name: "paste-\(Int(Date().timeIntervalSince1970)).png", data: png)
    }

    private static func textView(near view: NSView) -> NSTextView? {
        var ancestor = view.superview
        for _ in 0..<6 {
            guard let parent = ancestor else { return nil }
            if let found = firstTextView(in: parent) { return found }
            ancestor = parent.superview
        }
        return nil
    }

    private static func firstTextView(in view: NSView) -> NSTextView? {
        for child in view.subviews {
            if let textView = child as? NSTextView { return textView }
            if let found = firstTextView(in: child) { return found }
        }
        return nil
    }
}

/// Forwards everything to SwiftUI's own delegate except a file arriving as text.
@MainActor
final class PromptTextDelegate: NSObject, NSTextViewDelegate {
    weak var original: (any NSTextViewDelegate)?
    var attach: ([URL]) -> Void = { _ in }

    func textView(_ textView: NSTextView, shouldChangeTextIn range: NSRange, replacementString: String?) -> Bool {
        if let replacement = replacementString, let files = Self.droppedFiles(matching: replacement) {
            attach(files)
            return false
        }
        return original?.textView?(textView, shouldChangeTextIn: range, replacementString: replacementString) ?? true
    }

    /// The text view writes a dropped or pasted file as its path, one per line — exactly the
    /// files the drag or general pasteboard holds, which is how a typed path never matches.
    /// Pasteboard contents are read only for such a path: macOS treats clipboard reads outside
    /// a paste as prying and may ask the operator about them.
    static func droppedFiles(matching replacement: String,
                             pasteboards: [NSPasteboard] = [NSPasteboard(name: .drag), .general]) -> [URL]? {
        guard replacement.hasPrefix("/"), replacement.count > 1 else { return nil }
        for pasteboard in pasteboards where pasteboard.types?.contains(.fileURL) == true {
            guard let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL],
                  !urls.isEmpty else { continue }
            if urls.map(\.path).joined(separator: "\n") == replacement { return urls }
        }
        return nil
    }

    override func responds(to selector: Selector!) -> Bool {
        super.responds(to: selector) || (original?.responds(to: selector) ?? false)
    }

    override func forwardingTarget(for selector: Selector!) -> Any? {
        if original?.responds(to: selector) == true { return original }
        return super.forwardingTarget(for: selector)
    }
}
