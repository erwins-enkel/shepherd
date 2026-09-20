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

    typealias Progress = @Sendable (Int) async -> Void
    nonisolated static let maximumFileBytes = 250 * 1024 * 1024
    enum FileError: Error { case tooLarge }

    private var batchIDs: Set<UUID> = []
    private var sentBytes: [UUID: Int] = [:]
    private var transferID: UUID?
    private(set) var rows: [Row] = []
    private(set) var pendingImports = 0
    private(set) var uploading = false
    var importError: String?
    @ObservationIgnored private let upload: (Data, String, @escaping Progress) async throws -> String
    @ObservationIgnored private var worker: Task<Void, Never>?
    private var generation = 0
    private var stopped = false

    init(uploadWithProgress: @escaping (Data, String, @escaping Progress) async throws -> String) {
        upload = uploadWithProgress
    }

    convenience init(upload: @escaping (Data, String) async throws -> String) {
        self.init(uploadWithProgress: { data, name, _ in try await upload(data, name) })
    }

    convenience init(client: ShepherdClient) {
        self.init(uploadWithProgress: { data, name, progress in
            try await AttachmentTransfer.upload(client: client, data: data, name: name, progress: progress)
        })
    }

    var hasOutstandingUploads: Bool { uploading || pendingImports > 0 || rows.contains { $0.state != .uploaded } }

    /// Only the current batch contributes; transport callbacks include active-file bytes.
    var progressPercent: Int {
        let batch = rows.filter { batchIDs.contains($0.id) }
        guard !batch.isEmpty else { return 0 }
        if !hasOutstandingUploads { return 100 }
        let total = batch.reduce(0.0) { $0 + Double($1.byteCount) }
        let sent = batch.reduce(0.0) { $0 + Double(sentBytes[$1.id] ?? 0) }
        guard total > 0 else { return 0 }
        return min(99, Int((sent / total * 100).rounded()))
    }

    nonisolated static func readBounded(
        size: Int, limit: Int = maximumFileBytes, read: (Int) throws -> Data
    ) throws -> Data {
        guard size <= limit else { throw FileError.tooLarge }
        var data = Data()
        while true {
            try Task.checkCancellation()
            let chunk = try read(min(64 * 1024, limit - data.count + 1))
            guard chunk.count <= limit - data.count else { throw FileError.tooLarge }
            if chunk.isEmpty { return data }
            data.append(chunk)
        }
    }

    nonisolated static func readFile(_ url: URL) throws -> Data {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        // Reject before opening the stream; the bounded loop also catches subsequent growth.
        guard size <= maximumFileBytes else { throw FileError.tooLarge }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        return try readBounded(size: size) { try handle.read(upToCount: $0) ?? Data() }
    }

    func addFiles(_ urls: [URL]) { addFiles(urls.filter(\.isFileURL).map { File(url: $0) }) }

    func addFiles(_ files: [File]) {
        guard !stopped else { return }
        if worker == nil { batchIDs = []; sentBytes = [:] }
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
            batchIDs.insert(row.id)
        }
        startWorker()
    }

    func retry(_ id: UUID) {
        guard !stopped, let index = rows.firstIndex(where: { $0.id == id && $0.state == .failed }) else { return }
        if worker == nil { batchIDs = []; sentBytes = [:] }
        batchIDs.insert(id)
        sentBytes[id] = 0
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
            let transfer = UUID()
            transferID = transfer
            update(row.id) { $0.state = .uploading }
            do {
                let data: Data
                switch row.file.source {
                case .data(let bytes): data = bytes
                case .url(let url):
                    // Disk IO stays off the UI actor; balance the picker sandbox lease.
                    data = try await Task.detached { try Self.readFile(url) }.value
                }
                guard data.count <= Self.maximumFileBytes else { throw FileError.tooLarge }
                guard !stopped, mine == generation else { return }
                guard rows.contains(where: { $0.id == row.id }) else { continue }
                update(row.id) { $0.byteCount = data.count }
                let path = try await upload(data, row.file.name) { [weak self] sent in
                    await self?.recordProgress(sent, rowID: row.id, transfer: transfer, generation: mine)
                }
                guard !stopped, mine == generation else { return }
                transferID = nil
                sentBytes[row.id] = data.count
                update(row.id) { $0.path = path; $0.state = .uploaded; $0.error = nil }
            } catch {
                guard !stopped, mine == generation else { return }
                let reason: String
                transferID = nil
                if error is FileError { reason = L.t("files_upload_too_large", row.file.name) }
                else if case ComposeUploadError.fileTooLarge(let message) = error { reason = message }
                else if error is CocoaError { reason = error.localizedDescription }
                else { reason = ShepherdErrorCopy.message(error) }
                update(row.id) { $0.state = .failed; $0.error = L.t("newtask_upload_failed", reason) }
            }
        }
    }

    private func recordProgress(_ sent: Int, rowID: UUID, transfer: UUID, generation mine: Int) {
        guard !stopped, mine == generation, transferID == transfer,
              let row = rows.first(where: { $0.id == rowID }) else { return }
        sentBytes[rowID] = max(sentBytes[rowID] ?? 0, max(0, min(row.byteCount, sent)))
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
        transferID = nil
        batchIDs = []; sentBytes = [:]
        rows = []
        pendingImports = 0
        importError = nil
    }
}

/// The generated transport has no task delegate hook. Keep this upload-only adapter local;
/// response/error schemas remain generated, and no second generated client is constructed.
final class AttachmentTransfer: NSObject, URLSessionTaskDelegate {
    let progress: AttachmentModel.Progress
    let headerBytes: Int
    let fileBytes: Int

    init(progress: @escaping AttachmentModel.Progress, headerBytes: Int, fileBytes: Int) {
        self.progress = progress; self.headerBytes = headerBytes; self.fileBytes = fileBytes
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                    totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        let sent = max(0, min(fileBytes, Int(clamping: totalBytesSent) - headerBytes))
        Task { await progress(sent) }
    }

    // An upload is never redirected to another origin with the operator's credential.
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest) async -> URLRequest? { nil }

    static func upload(client: ShepherdClient, data: Data, name: String,
                       progress: @escaping AttachmentModel.Progress,
                       send: @Sendable (URLRequest, Data, AttachmentTransfer) async throws -> (Data, URLResponse) = {
                           try await URLSession.shared.upload(for: $0, from: $1, delegate: $2)
                       }) async throws -> String {
        let boundary = UUID().uuidString
        let filename = name.replacingOccurrences(of: "%", with: "%25")
            .replacingOccurrences(of: "\r", with: "%0D").replacingOccurrences(of: "\n", with: "%0A")
            .replacingOccurrences(of: "\"", with: "%22")
        let header = Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\nContent-Type: application/octet-stream\r\n\r\n".utf8)
        var body = header
        body.append(data)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        var request = URLRequest(url: client.profile.baseURL.appendingPathComponent("api/uploads"))
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        let token = client.currentToken()
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let delegate = AttachmentTransfer(progress: progress, headerBytes: header.count, fileBytes: data.count)
        let (responseData, response) = try await send(request, body, delegate)
        guard let response = response as? HTTPURLResponse else { throw ShepherdError.badRequest("HTTP") }
        switch response.statusCode {
        case 200: return try JSONDecoder().decode(Components.Schemas.UploadResponse.self, from: responseData).path
        case 400: throw ShepherdError.badRequest(try JSONDecoder().decode(Components.Schemas._Error.self, from: responseData).error)
        case 401:
            // Revalidate through the normal auth middleware. It owns credential comparison,
            // clearing and needsLogin; this read cannot create a session or upload a file.
            if token != nil, token == client.currentToken() { _ = try? await client.settings() }
            throw ShepherdError.unauthenticated
        case 404: throw ShepherdError.notFound
        case 413: throw ComposeUploadError.fileTooLarge(try JSONDecoder().decode(Components.Schemas._Error.self, from: responseData).error)
        default: throw ShepherdError.fromUndocumented(statusCode: response.statusCode, route: "uploadFile")
        }
    }
}
