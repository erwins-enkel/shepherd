import Foundation
import Observation
import ShepherdKit

/// One ordered list owns both the original filename and the server's staged path.
@Observable @MainActor
public final class AttachmentModel {
    public struct File: Sendable {
        enum Source: Sendable { case url(URL), data(Data) }
        public let name: String
        let source: Source

        public init(url: URL) { name = url.lastPathComponent; source = .url(url) }
        public init(name: String, data: Data) { self.name = name; source = .data(data) }
    }

    public struct Row: Identifiable, Sendable {
        public enum State: Sendable { case queued, uploading, failed, uploaded }
        public let id = UUID()
        public let file: File
        var byteCount: Int = 0
        public var state: State = .queued
        public var path: String?
        public var error: String?
    }

    typealias Progress = @Sendable (Int) async -> Void
    /// Begins platform keep-alive work (e.g. an iOS background task) and returns its release.
    public typealias KeepAlive = @MainActor () -> @MainActor () -> Void
    nonisolated static let maximumFileBytes = 250 * 1024 * 1024
    enum FileError: Error { case tooLarge }

    private var batchIDs: Set<UUID> = []
    private var sentBytes: [UUID: Int] = [:]
    private var transferID: UUID?
    private var batchStartedAt = Date.distantPast
    public private(set) var rows: [Row] = []
    private(set) var pendingImports = 0
    private(set) var uploading = false
    public var importError: String?
    /// Held for exactly one drain, so a brief app switch does not cut the transfer.
    @ObservationIgnored public var keepAlive: KeepAlive?
    @ObservationIgnored private var releaseKeepAlive: (@MainActor () -> Void)?
    @ObservationIgnored private var settleWaiters: [CheckedContinuation<Void, Never>] = []
    @ObservationIgnored private let upload: (Data, String, @escaping Progress) async throws -> String
    @ObservationIgnored private let clock: () -> Date
    @ObservationIgnored private var worker: Task<Void, Never>?
    private var generation = 0
    private var stopped = false

    init(uploadWithProgress: @escaping (Data, String, @escaping Progress) async throws -> String,
         clock: @escaping () -> Date = { Date() }) {
        upload = uploadWithProgress
        self.clock = clock
    }

    convenience init(upload: @escaping (Data, String) async throws -> String) {
        self.init(uploadWithProgress: { data, name, _ in try await upload(data, name) })
    }

    convenience init(client: ShepherdClient) {
        self.init(uploadWithProgress: { data, name, progress in
            try await client.uploadFile(data: data, filename: name, progress: progress).path
        })
    }

    /// Session uploads reuse the composer queue without changing composer staging.
    public static func forSession(client: ShepherdClient, sessionID: String) -> AttachmentModel {
        AttachmentModel(uploadWithProgress: { data, name, progress in
            try await client.uploadFile(data: data, filename: name, sessionID: sessionID, progress: progress).path
        })
    }

    public var hasOutstandingUploads: Bool { uploading || pendingImports > 0 || rows.contains { $0.state != .uploaded } }

    /// Outstanding work that will still settle on its own; a failed row waits for the operator instead.
    public var inFlight: Bool { uploading || pendingImports > 0 || rows.contains(where: Self.isActive) }

    public var hasFailedUploads: Bool { rows.contains { $0.state == .failed } }

    private static func isActive(_ row: Row) -> Bool { row.state == .queued || row.state == .uploading }

    /// Nil when nothing is pending; otherwise what the footer should say right now.
    public var status: UploadStatus? {
        guard uploading || rows.contains(where: Self.isActive) else {
            if pendingImports > 0 { return .init(phase: .preparing) }
            return hasFailedUploads ? .init(phase: .failed) : nil
        }
        let batch = rows.filter { batchIDs.contains($0.id) }
        guard !batch.isEmpty else { return nil }
        let done = batch.filter { $0.state == .uploaded }.count
        let active = batch.contains { $0.state == .uploading } ? 1 : 0
        let total = batch.reduce(0) { $0 + $1.byteCount }
        let sent = batch.reduce(0) { $0 + min($1.byteCount, sentBytes[$1.id] ?? 0) }
        var status = UploadStatus(phase: total > 0 && sent >= total ? .finishing : .transferring,
                                  current: min(batch.count, done + active), total: batch.count, percent: progressPercent)
        let elapsed = clock().timeIntervalSince(batchStartedAt)
        if status.phase == .transferring, sent > 0, elapsed >= 1 {
            status.remainingSeconds = Int((Double(total - sent) / (Double(sent) / elapsed)).rounded(.up))
        }
        return status
    }

    /// Returns once nothing is in flight, or once the queue is torn down.
    public func settled() async {
        guard !stopped, inFlight else { return }
        await withCheckedContinuation { settleWaiters.append($0) }
    }

    private func resumeSettledWaitersIfIdle() {
        guard stopped || !inFlight else { return }
        let waiters = settleWaiters
        settleWaiters = []
        waiters.forEach { $0.resume() }
    }

    /// Only the current batch contributes; transport callbacks include active-file bytes.
    public var progressPercent: Int {
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

    public func addFiles(_ urls: [URL]) { addFiles(urls.filter(\.isFileURL).map { File(url: $0) }) }

    public func addFiles(_ files: [File]) {
        guard !stopped else { return }
        if worker == nil { batchIDs = []; sentBytes = [:]; batchStartedAt = clock() }
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

    public func retry(_ id: UUID) {
        guard !stopped, let index = rows.firstIndex(where: { $0.id == id && $0.state == .failed }) else { return }
        if worker == nil { batchIDs = []; sentBytes = [:]; batchStartedAt = clock() }
        batchIDs.insert(id)
        sentBytes[id] = 0
        rows[index].error = nil
        rows[index].state = .queued
        startWorker()
    }

    public func retryFailed() {
        for row in rows where row.state == .failed { retry(row.id) }
    }

    public func remove(_ id: UUID) {
        rows.removeAll { $0.id == id }
        // Keep the active transport serial even if its visible row was removed.
    }

    public func beginImport() -> Int? {
        guard !stopped else { return nil }
        pendingImports += 1
        return generation
    }

    public func finishImport(_ file: File?, error: String?, generation mine: Int) {
        guard !stopped, mine == generation else { return }
        pendingImports -= 1
        importError = error
        if let file { addFiles([file]) }
        resumeSettledWaitersIfIdle()
    }

    private func startWorker() {
        guard worker == nil, !stopped else { return }
        let mine = generation
        uploading = true
        releaseKeepAlive = keepAlive?()
        worker = Task { [weak self] in await self?.drain(generation: mine) }
    }

    private func endKeepAlive() {
        releaseKeepAlive?()
        releaseKeepAlive = nil
    }

    private func drain(generation mine: Int) async {
        defer {
            if mine == generation {
                worker = nil; uploading = false
                endKeepAlive()
                resumeSettledWaitersIfIdle()
            }
        }
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

    public func teardown() {
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
        endKeepAlive()
        resumeSettledWaitersIfIdle()
    }
}
