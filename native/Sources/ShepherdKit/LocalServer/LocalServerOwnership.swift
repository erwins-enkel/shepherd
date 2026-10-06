#if os(macOS)
import Foundation
import CryptoKit
import Darwin

/// The kernel's birth timestamp distinguishes a process from a reused pid.
struct KernelProcessIdentity: Codable, Sendable, Equatable {
  let seconds: UInt64
  let microseconds: UInt64

  static func read(_ pid: Int32, requireRunning: Bool = true) -> Self? {
    guard pid > 1 else { return nil }
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size,
          !requireRunning || info.pbi_status != SZOMB else { return nil }
    return Self(seconds: info.pbi_start_tvsec, microseconds: info.pbi_start_tvusec)
  }

  static func groupMembers(_ group: Int32) -> [(Int32, Self)] {
    let size = proc_listpids(UInt32(PROC_PGRP_ONLY), UInt32(group), nil, 0)
    guard size > 0 else { return [] }
    var pids = [Int32](repeating: 0, count: Int(size) / MemoryLayout<Int32>.size + 32)
    let bytes = pids.withUnsafeMutableBytes {
      proc_listpids(UInt32(PROC_PGRP_ONLY), UInt32(group), $0.baseAddress, Int32($0.count))
    }
    return pids.prefix(max(0, Int(bytes)) / MemoryLayout<Int32>.size).compactMap { pid in
      guard getpgid(pid) == group, let identity = read(pid) else { return nil }
      return (pid, identity)
    }
  }
}

/// A pid alone never grants ownership: adoption also checks its group, port,
/// installation directory and the unique identity returned by `/api/health`.
struct LocalServerOwnership: Codable, Sendable {
  let pid: Int32
  let processGroup: Int32
  let port: Int
  let spawnedAt: Date
  let processStart: KernelProcessIdentity?
  let executable: String
  let appDirectory: String
  let expectedIdentity: LocalServerIdentity
  var identity: LocalServerIdentity?

  static func configurationName(_ environment: LocalServerEnvironment) -> String {
    let paths = [environment.appDirectory, environment.databasePath].map {
      $0.standardizedFileURL.resolvingSymlinksInPath().path
    }
    let hash = SHA256.hash(data: Data(paths.joined(separator: "\0").utf8))
      .prefix(12).map { String(format: "%02x", $0) }.joined()
    return "app-server-\(environment.port)-\(hash)"
  }
}

/// File output keeps working after the app closes its own descriptors. Reading
/// bounded chunks keeps both partial lines and catch-up memory bounded.
enum LocalServerLogTail {
  static let maxFileBytes: UInt64 = 10 * 1024 * 1024

  /// Keep the inherited inode open: renaming would strand the server's writer.
  /// O_APPEND on that writer ensures the next write starts at the new EOF.
  static func maintain(_ url: URL, limit: UInt64 = maxFileBytes) {
    guard let handle = try? FileHandle(forUpdating: url) else { return }
    defer { try? handle.close() }
    guard let size = try? handle.seekToEnd(), size > limit else { return }
    let previous = URL(fileURLWithPath: url.path + ".1")
    guard (try? handle.seek(toOffset: size - limit)) != nil,
          let bytes = try? handle.read(upToCount: Int(limit)) else { return }
    try? bytes.write(to: previous, options: .atomic)
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: previous.path)
    try? handle.truncate(atOffset: 0)
  }
  static func redact(_ secret: String, in url: URL) {
    let needle = Data(secret.utf8)
    guard !needle.isEmpty, let handle = try? FileHandle(forUpdating: url) else { return }
    defer { try? handle.close() }
    var carry = Data()
    var offset: UInt64 = 0
    while let chunk = try? handle.read(upToCount: ProcessOutputPump.maxPartialLineBytes), !chunk.isEmpty {
      let bytes = carry + chunk
      let base = offset - UInt64(carry.count)
      var start = bytes.startIndex
      while start < bytes.endIndex, let range = bytes.range(of: needle, in: start..<bytes.endIndex) {
        let replacement = [UInt8](repeating: UInt8(ascii: "*"), count: needle.count)
        _ = replacement.withUnsafeBytes {
          pwrite(handle.fileDescriptor, $0.baseAddress, $0.count, off_t(base + UInt64(range.lowerBound)))
        }
        start = range.upperBound
      }
      offset += UInt64(chunk.count)
      carry = Data(bytes.suffix(needle.count - 1))
    }
  }

  static func run(_ url: URL, onLine: (String) async -> Void) async {
    guard var handle = try? FileHandle(forReadingFrom: url) else { return }
    defer { try? handle.close() }
    var partial: [UInt8] = []
    func flush() async {
      guard !partial.isEmpty else { return }
      if partial.last == UInt8(ascii: "\r") { partial.removeLast() }
      let line = String(decoding: partial, as: UTF8.self)
      partial.removeAll(keepingCapacity: true)
      await onLine(line)
    }
    // Drain once even if cancelled before this task started, so a short-lived
    // child still contributes its final output before the next log rotates.
    while true {
      var opened = stat()
      var current = stat()
      if fstat(handle.fileDescriptor, &opened) == 0, stat(url.path, &current) == 0 {
        if opened.st_ino != current.st_ino || opened.st_dev != current.st_dev {
          try? handle.close()
          guard let replacement = try? FileHandle(forReadingFrom: url) else { break }
          handle = replacement
          partial.removeAll(keepingCapacity: true)
        } else if let offset = try? handle.offset(), UInt64(max(0, current.st_size)) < offset {
          try? handle.seek(toOffset: 0)
          partial.removeAll(keepingCapacity: true)
        }
      }
      let bytes: Data
      do { bytes = try handle.read(upToCount: ProcessOutputPump.maxPartialLineBytes) ?? Data() }
      catch { break }
      if bytes.isEmpty {
        if Task.isCancelled { break }
        do { try await Task.sleep(for: .milliseconds(100)) } catch { break }
        continue
      }
      for byte in bytes {
        if byte == UInt8(ascii: "\n") { await flush() }
        else {
          partial.append(byte)
          if partial.count >= ProcessOutputPump.maxPartialLineBytes { await flush() }
        }
      }
      if Task.isCancelled { break }
    }
    await flush()
  }
}
#endif
