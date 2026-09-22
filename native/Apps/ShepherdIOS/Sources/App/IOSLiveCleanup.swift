import Foundation
import Darwin
import ShepherdKit

/// Contains only this launch's paths. The token-bearing handoff never enters UI or logs.
struct IOSLiveCleanup: Sendable {
    let runID: String
    let statusPath: String
    let handoffPath: String
    struct Handoff: Codable, Sendable {
        let runID: String
        let tokenID: String
        let token: String
        let baseURL: String
    }
    struct Status: Codable, Sendable {
        let runID: String
        let tokenID: String
        let phase: String
    }

    func record(_ credential: StoredCredential, profile: ServerProfile) throws {
        try privateWrite(JSONEncoder().encode(Handoff(runID: runID, tokenID: credential.tokenId,
            token: credential.token, baseURL: profile.baseURL.absoluteString)), to: handoffPath)
        try status(tokenID: credential.tokenId, phase: "pending")
    }

    func revoke() async throws {
        let handoff = try JSONDecoder().decode(Handoff.self, from: Data(contentsOf: URL(fileURLWithPath: handoffPath)))
        guard handoff.runID == runID, let url = URL(string: handoff.baseURL) else { throw CocoaError(.fileReadCorruptFile) }
        let profile = ServerProfile(name: "Live", baseURL: url, mode: .remote)
        let owned = InMemoryCredentialStore()
        try owned.save(.init(token: handoff.token, tokenId: handoff.tokenID), for: profile.credentialKey)
        try status(tokenID: handoff.tokenID, phase: "revocation_requested")
        do {
            try Task.checkCancellation()
            try await ProfileSetup.logout(profile: profile, credentials: owned)
            try Task.checkCancellation()
            try status(tokenID: handoff.tokenID, phase: "revocation_returned")
        } catch {
            try? status(tokenID: handoff.tokenID, phase: "pending")
            throw error
        }
        // The harness must still prove HTTP 401 before deleting the private handoff.
    }

    private func status(tokenID: String, phase: String) throws {
        try privateWrite(JSONEncoder().encode(Status(runID: runID, tokenID: tokenID, phase: phase)), to: statusPath)
    }

    private func privateWrite(_ data: Data, to path: String) throws {
        let target = URL(fileURLWithPath: path)
        let temporary = target.deletingLastPathComponent().appendingPathComponent(".\(UUID().uuidString)")
        let fd = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, S_IRUSR | S_IWUSR)
        guard fd >= 0 else { throw CocoaError(.fileWriteNoPermission) }
        let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        do {
            try file.write(contentsOf: data)
            try file.synchronize()
            try file.close()
            guard rename(temporary.path, target.path) == 0 else { throw CocoaError(.fileWriteUnknown) }
        } catch {
            try? file.close()
            try? FileManager.default.removeItem(at: temporary)
            throw error
        }
    }
}

/// Ownership is recorded inside save, before login may activate or a cancellation may land.
struct IOSOwnedCredentialStore: CredentialStore {
    let destination: any CredentialStore
    let cleanup: IOSLiveCleanup
    let profile: ServerProfile
    func load(for key: String) throws -> StoredCredential? { try destination.load(for: key) }
    func save(_ credential: StoredCredential, for key: String) throws {
        try cleanup.record(credential, profile: profile)
        try destination.save(credential, for: key)
    }
    func delete(for key: String) throws { try destination.delete(for: key) }
}
