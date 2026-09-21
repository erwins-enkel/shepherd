import Foundation
import Testing
@testable import Shepherd

@MainActor
struct AppUpdaterTests {
    private var info: [String: Any] {
        ["SUPublicEDKey": Data(repeating: 1, count: 32).base64EncodedString(),
         "SUFeedURL": "https://example.com/appcast.xml"]
    }

    @Test func distributedBuildCanUpdate() {
        #expect(AppUpdater.isConfigured(info: info, isIsolated: false))
    }

    @Test func isolatedBuildNeverChecksOrInstalls() {
        #expect(!AppUpdater.isConfigured(info: info, isIsolated: true))
        let updater = AppUpdater(isIsolated: true)
        #expect(!updater.isAvailable)
        #expect(!updater.canCheckForUpdates)
        updater.checkForUpdates()
    }

    @Test(arguments: ["", "$(SHEPHERD_UPDATE_PUBLIC_KEY)", "not-a-key", "AQ=="])
    func missingOrInvalidKeyDisablesUpdates(key: String) {
        var value = info
        value["SUPublicEDKey"] = key
        #expect(!AppUpdater.isConfigured(info: value, isIsolated: false))
    }

    @Test(arguments: ["http://example.com/feed.xml", "file:///tmp/feed.xml", "", "https:"])
    func insecureOrInvalidFeedDisablesUpdates(feed: String) {
        var value = info
        value["SUFeedURL"] = feed
        #expect(!AppUpdater.isConfigured(info: value, isIsolated: false))
    }
}
