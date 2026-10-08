import SwiftUI
import UIKit
import PhotosUI
import UniformTypeIdentifiers
import ImageIO
import Observation
import ShepherdAppCore
import ShepherdKit

/// A presence probe never fetches clipboard contents or triggers paste permission.
@MainActor @Observable
final class IOSClipboardVisibility {
    private let probe: () -> Bool
    private(set) var hasImage = false
    init(probe: @escaping () -> Bool = { UIPasteboard.general.hasImages }) { self.probe = probe }
    func refresh() { hasImage = probe() }
}

enum IOSAttachmentPaste {
    static func path(_ path: String, mime: String) -> String {
        mime.lowercased().hasPrefix("video/")
            ? path + " (screen-recording video — extract keyframes/audio with ffmpeg to view)" : path
    }
    static func path(_ path: String, filename: String) -> String {
        self.path(path, mime: UTType(filenameExtension: (filename as NSString).pathExtension)?.preferredMIMEType ?? "")
    }
    // The reply endpoint strips nested markers and bracket-pastes the complete message.
    static func reply(paths: [String], draft: String) -> String {
        (paths + [draft.trimmingCharacters(in: .whitespacesAndNewlines)])
            .filter { !$0.isEmpty }.joined(separator: "\n")
    }
}

/// The recipient is kept alive by the representable coordinator. Only an explicit
/// system paste invokes the providers; presence checks use hasImages separately.
struct IOSImagePasteControl: UIViewRepresentable {
    let receive: ([NSItemProvider]) -> Void
    var enabled = true
    func makeCoordinator() -> Recipient { Recipient(receive: receive) }
    func makeUIView(context: Context) -> UIPasteControl {
        let config = UIPasteControl.Configuration()
        config.displayMode = .iconOnly
        config.cornerStyle = .capsule
        config.baseForegroundColor = UIColor(ComposePalette.amber)
        config.baseBackgroundColor = UIColor(ComposePalette.amber.opacity(0.12))
        let control = UIPasteControl(configuration: config)
        control.target = context.coordinator
        control.accessibilityLabel = L.t("native_compose_paste")
        return control
    }
    func updateUIView(_ view: UIPasteControl, context: Context) {
        context.coordinator.receive = receive
        view.isEnabled = enabled
    }
    final class Recipient: UIResponder {
        var receive: ([NSItemProvider]) -> Void
        init(receive: @escaping ([NSItemProvider]) -> Void) {
            self.receive = receive
            super.init()
            pasteConfiguration = UIPasteConfiguration(acceptableTypeIdentifiers: [UTType.image.identifier])
        }
        override func paste(itemProviders: [NSItemProvider]) { receive(itemProviders) }
    }
}

/// Picked videos land in a temp file, so a long screen recording is not held in memory before upload.
struct IOSPickedMovie: Transferable {
    let url: URL
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { received in
            let ext = received.file.pathExtension.isEmpty ? "mov" : received.file.pathExtension
            let copy = FileManager.default.temporaryDirectory.appendingPathComponent("video-\(UUID().uuidString).\(ext)")
            try FileManager.default.copyItem(at: received.file, to: copy)
            return Self(url: copy)
        }
    }
}

extension PhotosPickerItem {
    var isMovie: Bool { supportedContentTypes.contains { $0.conforms(to: .movie) } }
}

struct IOSReplyCamera: UIViewControllerRepresentable {
    let receive: (UIImage?) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(receive: receive) }
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let receive: (UIImage?) -> Void
        init(receive: @escaping (UIImage?) -> Void) { self.receive = receive }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { receive(nil) }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            receive(info[.originalImage] as? UIImage)
        }
    }
}

@MainActor @Observable
final class IOSReplyImports {
    private(set) var thumbnails: [UUID: UIImage] = [:]
    let model: IOSTerminalPresentation
    init(model: IOSTerminalPresentation) { self.model = model }

    func photo(_ photo: PhotosPickerItem) {
        guard model.canAttach, let attachments = model.attachments, let stamp = attachments.beginImport() else { return }
        model.openWriting(focus: false)
        Task {
            do {
                if photo.isMovie {
                    let movie = try await photo.loadTransferable(type: IOSPickedMovie.self)
                    attachments.finishImport(movie.map { .init(url: $0.url) }, error: movie == nil ? L.t("native_ios_attachment_invalid") : nil, generation: stamp)
                    return
                }
                let data = try await photo.loadTransferable(type: Data.self)
                let ext = photo.supportedContentTypes.first?.preferredFilenameExtension ?? "jpg"
                finish(data, name: "photo-\(UUID().uuidString).\(ext)", attachments: attachments, stamp: stamp)
            } catch { attachments.finishImport(nil, error: ShepherdErrorCopy.message(error), generation: stamp) }
        }
    }
    func camera(_ image: UIImage) {
        guard model.canAttach, let attachments = model.attachments, let stamp = attachments.beginImport() else { return }
        model.openWriting(focus: false)
        finish(image.jpegData(compressionQuality: 0.9), name: "camera-\(UUID().uuidString).jpg", attachments: attachments, stamp: stamp)
    }
    func paste(_ providers: [NSItemProvider]) {
        guard model.canAttach, let attachments = model.attachments else { return }
        model.openWriting(focus: false)
        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
            guard let stamp = attachments.beginImport() else { continue }
            let name = "clipboard-\(Int(Date().timeIntervalSince1970 * 1000))-\(UUID().uuidString.prefix(6)).png"
            provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, error in
                Task { @MainActor in
                    // Normalize the authorized image to PNG, regardless of provider encoding.
                    let png = data.flatMap { UIImage(data: $0)?.pngData() }
                    if let error { attachments.finishImport(nil, error: error.localizedDescription, generation: stamp) }
                    else { self.finish(png, name: name, attachments: attachments, stamp: stamp) }
                }
            }
        }
    }
    private func finish(_ data: Data?, name: String, attachments: AttachmentModel, stamp: Int) {
        guard let data else {
            attachments.finishImport(nil, error: L.t("native_ios_attachment_invalid"), generation: stamp)
            return
        }
        attachments.finishImport(.init(name: name, data: data), error: nil, generation: stamp)
        if let row = attachments.rows.last(where: { $0.file.name == name }), let image = Self.thumbnail(data) {
            thumbnails[row.id] = image
        }
    }
    func files(_ urls: [URL]) {
        guard model.canAttach, let attachments = model.attachments else { return }
        model.openWriting(focus: false)
        attachments.addFiles(urls)
        for url in urls {
            guard let row = attachments.rows.last(where: { $0.file.name == url.lastPathComponent }),
                  UTType(filenameExtension: url.pathExtension)?.conforms(to: .image) == true else { continue }
            Task {
                let cgImage = await Task.detached {
                    let scoped = url.startAccessingSecurityScopedResource()
                    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil as CGImage? }
                    return CGImageSourceCreateThumbnailAtIndex(source, 0, [
                        kCGImageSourceCreateThumbnailFromImageAlways: true,
                        kCGImageSourceThumbnailMaxPixelSize: 80,
                        kCGImageSourceCreateThumbnailWithTransform: true
                    ] as CFDictionary)
                }.value
                if attachments.rows.contains(where: { $0.id == row.id }), let cgImage { thumbnails[row.id] = UIImage(cgImage: cgImage) }
            }
        }
    }
    func pruneThumbnails() {
        let ids = Set(model.attachments?.rows.map(\.id) ?? [])
        thumbnails = thumbnails.filter { ids.contains($0.key) }
    }
    private static func thumbnail(_ data: Data) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: 80,
                kCGImageSourceCreateThumbnailWithTransform: true
              ] as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }
}

struct IOSReplyAttachmentChips: View {
    let attachments: AttachmentModel
    let thumbnails: [UUID: UIImage]
    var rendersStaticFixture = false
    var enabled = true
    var body: some View {
        Group {
            if rendersStaticFixture { row.fixedSize().frame(maxWidth: .infinity, alignment: .leading).clipped() }
            else { ScrollView(.horizontal) { row }.scrollIndicators(.hidden) }
        }
    }
    private var row: some View {
        HStack(spacing: 8) {
            ForEach(attachments.rows) { file in
                HStack(spacing: 6) {
                    if let image = thumbnails[file.id] {
                        Image(uiImage: image).resizable().scaledToFill().frame(width: 28, height: 28).clipped().clipShape(RoundedRectangle(cornerRadius: 5))
                    } else { Image(systemName: "doc").frame(width: 28, height: 28) }
                    Text(verbatim: file.file.name).lineLimit(1).frame(maxWidth: 130)
                    if file.state == .uploaded { Image(systemName: "checkmark").foregroundStyle(ComposePalette.green) }
                    else if file.state == .failed {
                        Button { attachments.retry(file.id) } label: { Image(systemName: "arrow.clockwise").frame(width: 44, height: 44) }
                            .accessibilityLabel(L.t("common_retry"))
                    } else {
                        if rendersStaticFixture { Text(verbatim: "\(attachments.progressPercent)%") }
                        else { ProgressView(value: Double(attachments.progressPercent), total: 100).frame(width: 28) }
                    }
                    Button { attachments.remove(file.id) } label: { Image(systemName: "xmark").frame(width: 44, height: 44) }
                        .accessibilityLabel(L.t("native_ios_attachment_remove", file.file.name))
                }
                .buttonStyle(.plain).disabled(!enabled)
                .font(.system(.caption)).padding(.leading, 8)
                .foregroundStyle(file.state == .failed ? ComposePalette.red : ComposePalette.ink)
                .background(ComposePalette.panel2, in: Capsule())
                .overlay(Capsule().stroke(file.state == .failed ? ComposePalette.red : ComposePalette.line))
                .accessibilityElement(children: .contain)
                .accessibilityValue(file.error ?? (file.state == .uploaded ? L.t("native_compose_voice_done") : L.t("common_loading")))
                .help(file.error ?? file.file.name)
            }
        }
    }
}
