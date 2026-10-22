import ShepherdAppCore
import SwiftUI
import UniformTypeIdentifiers

struct AttachmentsRow: View {
    @Bindable var model: AttachmentModel
    @Binding var choosingFiles: Bool
    let composer: ComposeModel
    @State private var thumbnails: [UUID: CGImage] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Button { choosingFiles = true } label: {
                    Label(L.t("newtask_attach_label"), systemImage: "paperclip")
                }
                .disabled(model.hasOutstandingUploads)
                .help(L.t("newtask_attach_aria"))
                .modifier(ComposeKeycap(ids: ["attach"]))
                if composer.shapingOffered {
                    Button { Task { await composer.startShaping() } } label: {
                        Label(L.t("newtask_shape_label"), systemImage: "sparkles")
                    }
                    .disabled(composer.shapeBlocker != nil)
                    .accessibilityLabel(L.t("newtask_shape_aria"))
                    .accessibilityIdentifier("compose-shape")
                    .help(L.t("newtask_shape_hint"))
                }
                Spacer(minLength: 4)
                Text(verbatim: L.t("newtask_char_count", String(composer.prompt.utf16.count)))
                    .font(.caption).foregroundStyle(.secondary).monospacedDigit()
            }
            if let status = model.status {
                HStack {
                    if status.phase == .transferring || status.phase == .finishing {
                        ProgressView(value: Double(status.percent), total: 100).frame(width: 90)
                    }
                    Text(verbatim: status.line).monospacedDigit()
                }
            }
            if !model.rows.isEmpty {
                ScrollView(.horizontal) {
                    HStack(alignment: .top, spacing: 6) {
                        ForEach(model.rows) { row in
                            AttachmentChip(row: row, thumbnail: thumbnails[row.id], model: model)
                        }
                    }
                }
                .task(id: model.rows.map(\.id)) { await loadThumbnails() }
            }
            if let error = model.importError {
                Text(verbatim: error).font(.caption).foregroundStyle(.red)
            }
        }
        .focusable()
        .fileImporter(isPresented: $choosingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): model.addFiles(urls)
            case .failure(let error): model.importError = L.t("newtask_upload_failed", error.localizedDescription)
            }
        }
        .modifier(ComposeAttachmentInput(model: model))
    }

    /// Image rows get a preview once; rows that left take theirs along.
    private func loadThumbnails() async {
        let rows = model.rows
        thumbnails = thumbnails.filter { id, _ in rows.contains { $0.id == id } }
        for row in rows where row.file.isImage && thumbnails[row.id] == nil {
            guard let image = await row.file.thumbnail(maxPixelSize: 560), !Task.isCancelled else { continue }
            thumbnails[row.id] = image
        }
    }
}

/// One attachment: an image shows a thumbnail that previews on hover, click or focus, like the web chip.
struct AttachmentChip: View {
    let row: AttachmentModel.Row
    let thumbnail: CGImage?
    let model: AttachmentModel
    @State private var previewing = false
    @State private var hover: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                if let thumbnail {
                    Button { previewing.toggle() } label: {
                        Image(thumbnail, scale: 1, label: Text(verbatim: row.file.name))
                            .resizable().scaledToFill()
                            .frame(width: 22, height: 22)
                            .clipShape(RoundedRectangle(cornerRadius: 4))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(L.t("newtask_preview_image_aria", row.file.name))
                    .onHover { inside in
                        hover?.cancel()
                        if inside {
                            // The same pause as the web chip, so sweeping across the row never flashes previews.
                            hover = Task {
                                try? await Task.sleep(for: .milliseconds(500))
                                if !Task.isCancelled { previewing = true }
                            }
                        } else {
                            previewing = false
                        }
                    }
                    .popover(isPresented: $previewing, arrowEdge: .top) {
                        Image(thumbnail, scale: 1, label: Text(verbatim: row.file.name))
                            .resizable().scaledToFit()
                            .frame(maxWidth: 280, maxHeight: 200)
                            .padding(4)
                    }
                } else {
                    Image(systemName: row.path == nil ? "doc" : "checkmark.circle")
                }
                Text(verbatim: row.file.name).lineLimit(1).frame(maxWidth: 180)
                if row.state == .failed {
                    Button(L.t("common_retry")) { model.retry(row.id) }
                }
                Button { model.remove(row.id) } label: {
                    Image(systemName: "xmark.circle.fill")
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L.t("newtask_remove_image_aria"))
            }
            .padding(6)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
            if let error = row.error {
                Text(verbatim: error).font(.caption).foregroundStyle(.red)
            }
        }
    }
}

/// Both the prompt editor and attachment row accept the same clipboard/drop inputs.
struct ComposeAttachmentInput: ViewModifier {
    let model: AttachmentModel

    func body(content: Content) -> some View {
        content.onPasteCommand(of: [.fileURL, .image]) { model.paste($0) }
        .dropDestination(for: URL.self) { urls, _ in
            let files = urls.filter(\.isFileURL)
            guard !files.isEmpty else { return false }
            model.addFiles(files)
            return true
        }
    }
}

extension AttachmentModel {
    /// Provider reads reserve readiness immediately, before any asynchronous clipboard delivery.
    /// File URLs take precedence over image representations of the same pasteboard item.
    func paste(_ providers: [NSItemProvider]) {
        for provider in providers {
            let isURL = provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
            let type = isURL ? UTType.fileURL.identifier : provider.registeredTypeIdentifiers.first {
                UTType($0)?.conforms(to: .image) == true
            }
            guard let type, let mine = beginImport() else { continue }
            let ext = UTType(type)?.preferredFilenameExtension ?? "png"
            let suggested = provider.suggestedName ?? UUID().uuidString
            let name = (suggested as NSString).pathExtension.isEmpty ? "\(suggested).\(ext)" : suggested
            provider.loadDataRepresentation(forTypeIdentifier: type) { [weak self] data, error in
                let reason = error?.localizedDescription
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    let file: File?
                    if let data, isURL {
                        file = URL(dataRepresentation: data, relativeTo: nil).flatMap {
                            $0.isFileURL ? File(url: $0) : nil
                        }
                    } else {
                        file = data.map { File(name: name, data: $0) }
                    }
                    self.finishImport(file, error: file == nil
                        ? L.t("newtask_upload_failed", reason ?? L.t("newtask_upload_unknown_reason")) : nil,
                        generation: mine)
                }
            }
        }
    }
}
