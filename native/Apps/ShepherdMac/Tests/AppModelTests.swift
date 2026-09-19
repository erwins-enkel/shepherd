import Foundation
import Testing
import ShepherdKit
@testable import Shepherd

@MainActor
struct AppModelTests {
    private func makeModel() -> AppModel {
        let name = UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
    }

    @Test func startsWithNoProfiles() {
        let model = makeModel()
        #expect(model.profiles.isEmpty)
        #expect(model.activeProfile == nil)
        #expect(model.store == nil)
    }

    @Test func addingARemoteProfileNormalisesTheAddress() throws {
        let model = makeModel()
        let profile = try model.addRemoteProfile(name: "Studio", address: "studio.example.ts.net/")
        #expect(profile.baseURL == URL(string: "https://studio.example.ts.net")!)
        #expect(profile.mode == .remote)
        #expect(profile.name == "Studio")
        #expect(model.profiles == [profile])
    }

    @Test func aBlankNameFallsBackToTheHost() throws {
        let model = makeModel()
        let profile = try model.addRemoteProfile(name: "   ", address: "https://studio.example.ts.net")
        #expect(profile.name == "studio.example.ts.net")
    }

    @Test func insecureAddressesAreRejectedAndNothingIsStored() {
        let model = makeModel()
        // The rejection comes from ShepherdKit's ServerProfile.validated(),
        // not from a second policy in this app.
        #expect(throws: ServerProfileError.insecureRemoteURL("studio.example.com")) {
            try model.addRemoteProfile(name: "Bad", address: "http://studio.example.com")
        }
        #expect(model.profiles.isEmpty)
    }

    @Test func plainHttpIsAllowedForLoopbackAndTailnetNames() throws {
        let model = makeModel()
        let loopback = try model.addRemoteProfile(name: "Local", address: "http://127.0.0.1:7330")
        #expect(loopback.baseURL == URL(string: "http://127.0.0.1:7330")!)
        let tailnet = try model.addRemoteProfile(name: "Box", address: "http://box.tail1234.ts.net")
        #expect(tailnet.baseURL == URL(string: "http://box.tail1234.ts.net")!)
    }

    @Test func aTsNetSuffixOnlyCountsOnALabelBoundary() {
        let model = makeModel()
        #expect(throws: ServerProfileError.insecureRemoteURL("evilts.net")) {
            try model.addRemoteProfile(name: "Evil", address: "http://evilts.net")
        }
    }

    @Test func blankAddressesAreAFormError() {
        let model = makeModel()
        #expect(throws: RemoteServerForm.FieldError.empty) {
            try model.addRemoteProfile(name: "Bad", address: "   \n ")
        }
        #expect(model.profiles.isEmpty)
    }

    @Test func nonHttpSchemesAreAFormError() {
        let model = makeModel()
        #expect(throws: RemoteServerForm.FieldError.malformed) {
            try model.addRemoteProfile(name: "Bad", address: "ws://box.example.ts.net")
        }
        #expect(throws: RemoteServerForm.FieldError.malformed) {
            try model.addRemoteProfile(name: "Bad", address: "https://")
        }
    }

    @Test func pathsQueriesAndCaseAreStrippedFromTheAddress() throws {
        let model = makeModel()
        let profile = try model.addRemoteProfile(
            name: "Studio", address: "HTTPS://BOX.Example.TS.NET/api/health?x=1")
        #expect(profile.baseURL == URL(string: "https://box.example.ts.net")!)
    }

    @Test func credentialKeysAreUniquePerProfile() throws {
        let model = makeModel()
        let a = try model.addRemoteProfile(name: "A", address: "https://a.example.ts.net")
        let b = try model.addRemoteProfile(name: "B", address: "https://b.example.ts.net")
        #expect(a.credentialKey != b.credentialKey)
        #expect(a.credentialKey.hasPrefix("run.shepherd.mac."))
    }

    @Test func theLocalProfilePointsAtLoopback7330() {
        let model = makeModel()
        let profile = model.addLocalProfile()
        #expect(profile.baseURL == URL(string: "http://127.0.0.1:7330")!)
        #expect(profile.mode == .local)
    }

    @Test func addingTheLocalProfileTwiceReusesTheSameRow() {
        let model = makeModel()
        let first = model.addLocalProfile()
        let second = model.addLocalProfile()
        #expect(first.id == second.id)
        #expect(model.profiles.count == 1)
    }

    @Test func profilesSurviveARestart() throws {
        let name = UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)

        let first = AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
        let profile = try first.addRemoteProfile(name: "Studio", address: "https://studio.example.ts.net")

        let second = AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
        #expect(second.profiles == [profile])
    }

    @Test func removingAProfileDropsIt() throws {
        let model = makeModel()
        let profile = try model.addRemoteProfile(name: "Studio", address: "https://studio.example.ts.net")
        model.remove(profile)
        #expect(model.profiles.isEmpty)
        #expect(model.activeProfile == nil)
        #expect(model.store == nil)
    }

    @Test func appVersionComesFromTheBundle() {
        #expect(!makeModel().appVersion.isEmpty)
    }

    // MARK: - Connection routing

    @Test func needsLoginRoutesToTheLoginSheet() throws {
        let model = makeModel()
        let profile = try model.addRemoteProfile(name: "Studio", address: "https://studio.example.ts.net")
        model.routeSheet(for: .needsLogin, profile: profile)
        #expect(model.sheet == .login(profile))
    }

    @Test func firstRunPendingRoutesToTheFolderPicker() throws {
        let model = makeModel()
        let profile = try model.addRemoteProfile(name: "Studio", address: "https://studio.example.ts.net")
        model.routeSheet(for: .firstRunPending, profile: profile)
        #expect(model.sheet == .firstRun)
    }

    @Test func quietStatesOpenNoSheet() throws {
        let model = makeModel()
        let profile = try model.addRemoteProfile(name: "Studio", address: "https://studio.example.ts.net")
        for state: ConnectionState in [.idle, .connecting, .live, .offline(message: "timed out")] {
            model.sheet = nil
            model.routeSheet(for: state, profile: profile)
            #expect(model.sheet == nil, "\(state) should not open a sheet")
        }
    }

    @Test func anOpenSheetIsNotReplaced() throws {
        let model = makeModel()
        let profile = try model.addRemoteProfile(name: "Studio", address: "https://studio.example.ts.net")
        model.sheet = .newSession
        model.routeSheet(for: .needsLogin, profile: profile)
        #expect(model.sheet == .newSession)
    }
}
