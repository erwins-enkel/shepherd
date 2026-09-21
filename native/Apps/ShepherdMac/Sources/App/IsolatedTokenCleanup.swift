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

/// Saves ownership inside ProfileSetup's mint/store operation, before its caller can hop actors.
private struct IsolatedMintStore: CredentialStore {
    let owned: InMemoryCredentialStore
    let model: any CredentialStore
    func load(for key: String) throws -> StoredCredential? { try model.load(for: key) }
    func save(_ credential: StoredCredential, for key: String) throws {
        try owned.save(credential, for: key)
        try model.save(credential, for: key)
    }
    func delete(for key: String) throws { try model.delete(for: key) }
}

/// A single launch's mint and shutdown handoff, independent of the main actor.
/// Shutdown closes admission before awaiting an in-flight mint. Each of the at most four
/// sequential requests (login, mint, DELETE, probe) has a two-second resource deadline.
actor IsolatedTokenLifecycle {
    typealias SessionFactory = @Sendable (URLSessionConfiguration) -> URLSession
    private let profile: ServerProfile
    private let owned = InMemoryCredentialStore()
    private let sessionFactory: SessionFactory
    private var mint: Task<StoredCredential, any Error>?
    private var cleanup: Task<IsolatedCleanupStatus, Never>?

    init(profile: ServerProfile, sessionFactory: @escaping SessionFactory = { URLSession(configuration: $0) }) {
        self.profile = profile
        self.sessionFactory = sessionFactory
    }

    func login(password: String, credentials: any CredentialStore, tokenName: String) async throws {
        guard cleanup == nil, mint == nil else { throw CancellationError() }
        let store = IsolatedMintStore(owned: owned, model: credentials)
        let profile = profile
        let factory = sessionFactory
        let task = Task {
            try await ProfileSetup.login(profile: profile, password: password, credentials: store,
                tokenName: tokenName, urlSessionFactory: { configuration in
                    configuration.timeoutIntervalForRequest = 2
                    configuration.timeoutIntervalForResource = 2
                    return factory(configuration)
                })
        }
        mint = task
        _ = try await task.value
        // A delayed caller must never activate the now-revoked credential after Quit.
        guard cleanup == nil else { throw CancellationError() }
    }

    var isShuttingDown: Bool { cleanup != nil }

    func shutdown() async -> IsolatedCleanupStatus {
        if let cleanup { return await cleanup.value }
        let pending = mint
        let profile = profile
        let owned = owned
        let factory = sessionFactory
        let task = Task {
            // Do not cancel a mint that may already have reached the server: receive and
            // record its response first, then revoke exactly that token.
            _ = await pending?.result
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = 2
            configuration.timeoutIntervalForResource = 2
            let session = factory(configuration)
            defer { session.invalidateAndCancel() }
            return await IsolatedTokenCleanup.revoke(profile: profile, credentials: owned, urlSession: session)
        }
        cleanup = task
        return await task.value
    }
}
