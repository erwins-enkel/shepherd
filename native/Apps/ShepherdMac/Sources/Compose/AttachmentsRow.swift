import SwiftUI
import UniformTypeIdentifiers

struct AttachmentsRow: View {
    @Bindable var model: AttachmentModel
    @Binding var choosingFiles: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Button { choosingFiles = true } label: {
                    Label(L.t("newtask_attach_image"), systemImage: "paperclip")
                }
                if model.hasOutstandingUploads {
                    ProgressView(value: Double(model.progressPercent), total: 100).frame(width: 90)
                    Text(verbatim: L.t("newtask_uploading"))
                    Text(verbatim: L.t("newtask_upload_percent", String(model.progressPercent)))
                        .monospacedDigit()
                }
            }
            ForEach(model.rows) { row in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Image(systemName: row.path == nil ? "doc" : "checkmark.circle")
                        Text(verbatim: row.file.name).lineLimit(1)
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
