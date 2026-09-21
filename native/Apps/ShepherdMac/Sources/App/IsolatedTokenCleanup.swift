import Foundation
import ShepherdKit

/// Evidence only for tokens owned by isolated launches/test fixtures. Never used by operator logout.
struct IsolatedCleanupStatus: Codable, Equatable, Sendable {
    enum Failure: String, Codable, Sendable {
        case missingCredential, stillAuthorized, verificationFailed, timeout
    }
    var owned: Int
    var verified: Int
    var error: Failure?
    var succeeded: Bool { owned == 1 && verified == 1 && error == nil }

    func write(to path: String?) {
        guard let path, let data = try? JSONEncoder().encode(self) else { return }
        // The caller creates a private, per-launch directory. No credential ever enters this file.
        try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
    }
}

enum IsolatedTokenCleanup {
    /// Retain a separate in-memory credential before logout clears its store. Only an actual
    /// unauthorized response from the same repos read used by existing live fixtures proves cleanup.
    static func revoke(
        profile: ServerProfile, credentials: any CredentialStore, urlSession: URLSession? = nil
    ) async -> IsolatedCleanupStatus {
        let session: URLSession
        if let urlSession { session = urlSession } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = 2
            configuration.timeoutIntervalForResource = 2
            session = URLSession(configuration: configuration)
        }
        defer { if urlSession == nil { session.finishTasksAndInvalidate() } }
        do {
            guard let credential = try credentials.load(for: profile.credentialKey) else {
                return .init(owned: 0, verified: 0, error: .missingCredential)
            }
            let probeCredentials = InMemoryCredentialStore()
            try probeCredentials.save(credential, for: profile.credentialKey)
            try await ProfileSetup.logout(profile: profile, credentials: credentials, urlSession: session)
            let probe = try ShepherdClient(profile: profile, credentials: probeCredentials,
                urlSession: session, readOnlyAudit: ReadOnlyRequestAudit())
            do {
                _ = try await probe.repos()
            } catch ShepherdError.unauthenticated {
                return .init(owned: 1, verified: 1, error: nil)
            }
            return .init(owned: 1, verified: 0, error: .stillAuthorized)
        } catch {
            return .init(owned: 1, verified: 0, error: .verificationFailed)
        }
    }
}
