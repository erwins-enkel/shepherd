import Foundation
import Observation
import ShepherdKit

/// One ordered list owns both the original filename and the server's staged path.
@Observable @MainActor
final class AttachmentModel {
    struct File: Sendable {
        enum Source: Sendable { case url(URL), data(Data) }
        let name: String
        let source: Source

        init(url: URL) { name = url.lastPathComponent; source = .url(url) }
        init(name: String, data: Data) { self.name = name; source = .data(data) }
    }

    struct Row: Identifiable {
        enum State { case queued, uploading, failed, uploaded }
        let id = UUID()
        let file: File
        var byteCount: Int = 0
        var state: State = .queued
        var path: String?
        var error: String?
    }

    private(set) var rows: [Row] = []
    private(set) var pendingImports = 0
    private(set) var uploading = false
    var importError: String?
    @ObservationIgnored private let upload: (Data, String) async throws -> String
    @ObservationIgnored private var worker: Task<Void, Never>?
    private var generation = 0
    private var stopped = false

    init(upload: @escaping (Data, String) async throws -> String) { self.upload = upload }

    convenience init(client: ShepherdClient) {
        self.init { data, name in try await client.uploadFile(data: data, filename: name).path }
    }

    var hasOutstandingUploads: Bool { uploading || pendingImports > 0 || rows.contains { $0.state != .uploaded } }

    /// Count server-acknowledged bytes. The shared generated transport exposes no sent-byte
    /// callback; reporting completed-file bytes avoids mistaking buffered bytes for delivery.
    var progressPercent: Int {
        guard !rows.isEmpty else { return 0 }
        if !hasOutstandingUploads { return 100 }
        let total = rows.reduce(0.0) { $0 + Double($1.byteCount) }
        let completed = rows.filter { $0.state == .uploaded }.reduce(0.0) { $0 + Double($1.byteCount) }
        guard total > 0 else { return 0 }
        return min(99, Int((completed / total * 100).rounded()))
    }

    func addFiles(_ urls: [URL]) { addFiles(urls.filter(\.isFileURL).map { File(url: $0) }) }

    func addFiles(_ files: [File]) {
        guard !stopped else { return }
        for file in files {
            var row = Row(file: file)
            switch file.source {
            case .data(let data): row.byteCount = data.count
            case .url(let url):
                let scoped = url.startAccessingSecurityScopedResource()
                row.byteCount = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
                if scoped { url.stopAccessingSecurityScopedResource() }
            }
            rows.append(row)
        }
        startWorker()
    }

    func retry(_ id: UUID) {
        guard !stopped, let index = rows.firstIndex(where: { $0.id == id && $0.state == .failed }) else { return }
        rows[index].error = nil
        rows[index].state = .queued
        startWorker()
    }

    func remove(_ id: UUID) {
        rows.removeAll { $0.id == id }
        // Keep the active transport serial even if its visible row was removed.
    }

    func beginImport() -> Int? {
        guard !stopped else { return nil }
        pendingImports += 1
        return generation
    }

    func finishImport(_ file: File?, error: String?, generation mine: Int) {
        guard !stopped, mine == generation else { return }
        pendingImports -= 1
        importError = error
        if let file { addFiles([file]) }
    }

    private func startWorker() {
        guard worker == nil, !stopped else { return }
        let mine = generation
        uploading = true
        worker = Task { [weak self] in await self?.drain(generation: mine) }
    }

    private func drain(generation mine: Int) async {
        defer { if mine == generation { worker = nil; uploading = false } }
        while !stopped, mine == generation, let row = rows.first(where: { $0.state == .queued }) {
            update(row.id) { $0.state = .uploading }
            do {
                let data: Data
                switch row.file.source {
                case .data(let bytes): data = bytes
                case .url(let url):
                    // Disk IO stays off the UI actor; balance the picker sandbox lease.
                    data = try await Task.detached {
                        let scoped = url.startAccessingSecurityScopedResource()
                        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                        return try Data(contentsOf: url)
                    }.value
                }
                guard !stopped, mine == generation else { return }
                guard rows.contains(where: { $0.id == row.id }) else { continue }
                update(row.id) { $0.byteCount = data.count }
                let path = try await upload(data, row.file.name)
                guard !stopped, mine == generation else { return }
                update(row.id) { $0.path = path; $0.state = .uploaded; $0.error = nil }
            } catch {
                guard !stopped, mine == generation else { return }
                let reason: String
                if case ComposeUploadError.fileTooLarge(let message) = error { reason = message }
                else if error is CocoaError { reason = error.localizedDescription }
                else { reason = ShepherdErrorCopy.message(error) }
                update(row.id) { $0.state = .failed; $0.error = L.t("newtask_upload_failed", reason) }
            }
        }
    }

    private func update(_ id: UUID, _ change: (inout Row) -> Void) {
        guard let index = rows.firstIndex(where: { $0.id == id }) else { return }
        change(&rows[index])
    }

    func teardown() {
        stopped = true
        generation += 1
        worker?.cancel()
        worker = nil
        uploading = false
        rows = []
        pendingImports = 0
        importError = nil
    }
}
