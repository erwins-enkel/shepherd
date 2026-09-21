import Foundation
import ShepherdKit
import Testing
@testable import Shepherd
@testable import ShepherdAppCore

extension MacSeamTests {
@MainActor
struct AppModelTests {
    private func makeModel() -> AppModel {
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        return AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: MacTestSupport.environment(defaults: defaults))
    }
    @Test func appVersionIsTheBundlesShortVersionString() throws {
        let fromBundle = try #require(
            Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String)
        #expect(fromBundle != "0.0.0", "the test host must carry a real MARKETING_VERSION")
        #expect(makeModel().appVersion == fromBundle)
    }
}
}
