import Darwin
import Foundation

/// Copy from the running bundle (also readable on a DMG or in App Translocation).
/// Never move/delete the source and never replace a destination. Stage on the
/// destination volume so a failed copy cannot leave a launchable partial app.
enum AppInstallation {
    static func isInstalled(_ app: URL, roots: [URL]) -> Bool {
        let path = app.resolvingSymlinksInPath().standardizedFileURL.path
        return roots.contains { root in
            let rootPath = root.resolvingSymlinksInPath().standardizedFileURL.path
            return path.hasPrefix(rootPath + "/")
        }
    }

    static func copy(source: URL, to destination: URL) throws {
        let fm = FileManager.default
        let parent = destination.deletingLastPathComponent()
        try fm.createDirectory(at: parent, withIntermediateDirectories: true)
        let stage = parent.appendingPathComponent(".Shepherd-install-\(UUID().uuidString)")
        try fm.createDirectory(at: stage, withIntermediateDirectories: false)
        defer { try? fm.removeItem(at: stage) }
        let stagedApp = stage.appendingPathComponent("Shepherd.app")
        // ditto preserves executable modes, symlinks, extended attributes and
        // the signed framework layout, without changing the read-only source.
        try run("/usr/bin/ditto", [source.path, stagedApp.path])
        try run("/usr/bin/codesign", ["--verify", "--deep", "--strict", stagedApp.path])
        // Atomic, exclusive rename on the same volume: even a destination
        // created during the copy must never be overwritten.
        let result = stagedApp.path.withCString { sourcePath in
            destination.path.withCString { targetPath in
                renamex_np(sourcePath, targetPath, UInt32(RENAME_EXCL))
            }
        }
        guard result == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    }

    private static func run(_ executable: String, _ arguments: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw NSError(domain: "AppInstallation", code: Int(process.terminationStatus))
        }
    }
}

