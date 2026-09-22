import Foundation
import ShepherdKit
import Testing
@testable import Shepherd
@testable import ShepherdAppCore

/// Prepare the credential BEFORE constructing the model under test. Supplied tokens stay
/// caller-owned; password-minted tokens are verified on every exit, including a throwing body.
@MainActor
enum LiveTokenFixture {
    enum Failure: Error { case unexpectedLogin }
    static func withToken(
        address: String, suppliedToken: String?, password: String?,
        urlSession: URLSession? = nil,
        body: (String?) async throws -> Void
    ) async throws {
        if let suppliedToken {
            try await body(suppliedToken)
            return
        }
        let password = try #require(password)
        let profile = try ServerProfile(name: "live-fixture",
            baseURL: RemoteServerForm.normalize(address), mode: .remote,
            credentialKey: "live-fixture-\(UUID())").validated()
        let credentials = InMemoryCredentialStore()
        let credential = try await ProfileSetup.login(profile: profile, password: password,
            credentials: credentials, tokenName: ProfileSetup.tokenName(
                prefix: "Shepherd UI test (", hostName: "fixture-\(UUID())"),
            urlSessionFactory: { configuration in URLSession(configuration: urlSession?.configuration ?? configuration) })
        do {
            try await body(credential.token)
        } catch {
            await revokeOwnedLiveToken(profile: profile, credentials: credentials, urlSession: urlSession)
            throw error
        }
        await revokeOwnedLiveToken(profile: profile, credentials: credentials, urlSession: urlSession)
    }
}

/// Shared by the existing fixtures that previously checked only best-effort logout.
func revokeOwnedLiveToken(
    profile: ServerProfile, credentials: any CredentialStore, urlSession: URLSession? = nil
) async {
    let result = await IsolatedTokenCleanup.revoke(profile: profile, credentials: credentials, urlSession: urlSession)
    #expect(result.succeeded, "Owned live token cleanup must be 401 verified (counts/category only)")
    if result.succeeded { print("live fixture: minted test token revoked (401 verified)") }
}
