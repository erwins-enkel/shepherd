import Foundation
import Testing
@testable import Shepherd

struct AppInstallationTests {
    @Test func installedPathsRespectBoundariesAndSubfolders() {
        let roots = [URL(fileURLWithPath: "/Applications"), URL(fileURLWithPath: "/Users/test/Applications")]
        for path in ["/Applications/Shepherd.app", "/Applications/Tools/Shepherd.app", "/Users/test/Applications/Shepherd.app"] {
            #expect(AppInstallation.isInstalled(URL(fileURLWithPath: path), roots: roots))
        }
        for path in ["/Applications-other/Shepherd.app", "/Users/other/Applications/Shepherd.app", "/Volumes/Shepherd/Shepherd.app"] {
            #expect(!AppInstallation.isInstalled(URL(fileURLWithPath: path), roots: roots))
        }
    }

    @Test func resolvesSymlinkedRootsAndApps() throws {
        let fm = FileManager.default
        let temp = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try fm.createDirectory(at: temp.appendingPathComponent("real/Shepherd.app"), withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: temp) }
        let alias = temp.appendingPathComponent("alias")
        try fm.createSymbolicLink(at: alias, withDestinationURL: temp.appendingPathComponent("real"))
        #expect(AppInstallation.isInstalled(alias.appendingPathComponent("Shepherd.app"), roots: [temp.appendingPathComponent("real")]))
        #expect(AppInstallation.isInstalled(temp.appendingPathComponent("real/Shepherd.app"), roots: [alias]))
    }

    @Test func failedVerificationPreservesSourceAndExistingDestination() throws {
        let fm = FileManager.default
        let temp = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let source = temp.appendingPathComponent("Downloads/Shepherd.app")
        let target = temp.appendingPathComponent("Applications/Shepherd.app")
        try fm.createDirectory(at: source, withIntermediateDirectories: true)
        try fm.createDirectory(at: target, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: temp) }
        try Data("source".utf8).write(to: source.appendingPathComponent("marker"))
        try Data("existing".utf8).write(to: target.appendingPathComponent("marker"))
        #expect(throws: (any Error).self) { try AppInstallation.copy(source: source, to: target) }
        #expect(try String(contentsOf: source.appendingPathComponent("marker"), encoding: .utf8) == "source")
        #expect(try String(contentsOf: target.appendingPathComponent("marker"), encoding: .utf8) == "existing")
        #expect(try fm.contentsOfDirectory(atPath: target.deletingLastPathComponent().path) == ["Shepherd.app"])
        let emptyTarget = temp.appendingPathComponent("NewApplications/Shepherd.app")
        #expect(throws: (any Error).self) { try AppInstallation.copy(source: source, to: emptyTarget) }
        #expect(!fm.fileExists(atPath: emptyTarget.path))
        #expect(try fm.contentsOfDirectory(atPath: emptyTarget.deletingLastPathComponent().path).isEmpty)
    }

    @Test func successfulCopyAndCollisionKeepBothApps() throws {
        let fm = FileManager.default
        let temp = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? fm.removeItem(at: temp) }
        let source = temp.appendingPathComponent("Downloads/Shepherd.app")
        let target = temp.appendingPathComponent("Applications/Shepherd.app")
        try fm.createDirectory(at: source.appendingPathComponent("Contents/MacOS"), withIntermediateDirectories: true)
        try fm.copyItem(at: URL(fileURLWithPath: "/usr/bin/true"),
                        to: source.appendingPathComponent("Contents/MacOS/Shepherd"))
        let info: [String: Any] = ["CFBundleExecutable": "Shepherd", "CFBundleIdentifier": "run.shepherd.install-test",
                                   "CFBundlePackageType": "APPL", "CFBundleVersion": "1"]
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
            .write(to: source.appendingPathComponent("Contents/Info.plist"))
        let sign = Process()
        sign.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
        sign.arguments = ["--force", "--sign", "-", source.path]
        try sign.run()
        sign.waitUntilExit()
        #expect(sign.terminationStatus == 0)
        try AppInstallation.copy(source: source, to: target)
        #expect(fm.fileExists(atPath: source.appendingPathComponent("Contents/MacOS/Shepherd").path))
        #expect(fm.fileExists(atPath: target.appendingPathComponent("Contents/MacOS/Shepherd").path))
        // The second valid copy reaches the exclusive rename and must fail.
        #expect(throws: (any Error).self) { try AppInstallation.copy(source: source, to: target) }
        #expect(try fm.contentsOfDirectory(atPath: target.deletingLastPathComponent().path) == ["Shepherd.app"])
        #expect(try Data(contentsOf: source.appendingPathComponent("Contents/Info.plist")) ==
                Data(contentsOf: target.appendingPathComponent("Contents/Info.plist")))
    }

    @Test @MainActor func isolatedLaunchDoesNotPrompt() async {
        let prompt = AppInstallationPrompt(isIsolated: true)
        #expect(await !prompt.runIfNeeded())
        #expect(await !prompt.runIfNeeded())
    }
}
