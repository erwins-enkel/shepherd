import Foundation
import Observation
import ShepherdKit

/// Typed request boundary also lets lifecycle tests hold a completed HTTP response across close().
struct SettingsTokenRequests: Sendable {
    var authenticate: @Sendable (String) async throws -> Components.Schemas.AccessTokenList
    var mint: @Sendable (Components.Schemas.AccessTokenMintRequest) async throws -> Components.Schemas.AccessTokenMinted
    var revoke: @Sendable (String) async throws -> Void
    static func live(_ client: ShepherdClient) -> Self {
        .init(authenticate: { password in
            try await client.loginForTokenAdministration(password: password)
            try Task.checkCancellation()
            return try await client.listAccessTokens()
        }, mint: { try await client.mintAccessToken(body: $0) },
        revoke: { try await client.revokeAccessToken(id: $0) })
    }
}
@Observable @MainActor public final class SettingsTokensModel {
    public private(set) var entries: [Components.Schemas.AccessTokenSummary] = []
    public private(set) var revealed: String?
    public private(set) var authenticated = false
    public private(set) var busy = false
    public private(set) var error: String?
    @ObservationIgnored private var requests: SettingsTokenRequests?
    @ObservationIgnored private let makeRequests: (ShepherdClient) -> SettingsTokenRequests
    @ObservationIgnored private var activeClient: ShepherdClient?
    @ObservationIgnored private var session: URLSession?
    @ObservationIgnored private var work: Task<Void,Never>?
    @ObservationIgnored private var generation = 0
    init(requests: @escaping (ShepherdClient) -> SettingsTokenRequests = SettingsTokenRequests.live) {
        makeRequests = requests
    }
    @discardableResult
    public func authenticate(profile: ServerProfile, password: String, activeClient: ShepherdClient? = nil,
                      session: URLSession? = nil) -> Task<Void, Never>? {
        close()
        self.activeClient = activeClient
        let transport = session ?? URLSession(configuration: .ephemeral)
        self.session = transport
        do {
            // Empty credentials: a bearer header would make this a forbidden machine request.
            let client = try ShepherdClient(profile: profile, credentials: InMemoryCredentialStore(), urlSession: transport)
            requests = makeRequests(client)
        } catch { self.error = L.t("native_settings_login_failed"); return nil }
        guard let requests else { return nil }
        return execute { try await requests.authenticate(password) }
            commit: { [weak self] in self?.entries = $0.tokens; self?.authenticated = true }
    }
    public static func normalizedName(_ raw: String) -> String? {
        // ECMAScript trim's whitespace set, including BOM but excluding NEL (U+0085).
        let whitespace = CharacterSet(charactersIn: "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D}\u{0020}\u{00A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}")
        let name = raw.trimmingCharacters(in: whitespace)
        return !name.isEmpty && name.utf16.count <= 64 ? name : nil
    }
    public func canRevoke(id: String) -> Bool {
        guard let entry = entries.first(where: { $0.id == id }) else { return false }
        // A missing/unreadable credential cannot prove that a token is safe to revoke.
        guard let bearer = activeClient?.currentToken(), !bearer.isEmpty else { return false }
        // The kit exposes plaintext but keeps StoredCredential.tokenId private. Protect every
        // matching hint conservatively, including collisions, without opening a second credential store.
        return entry.hint != String(bearer.suffix(4))
    }
    @discardableResult
    public func mint(name: String, days: Components.Schemas.AccessTokenMintRequest.ExpiresInDaysPayload?,
              scope: Components.Schemas.TokenScope) -> Task<Void, Never>? {
        guard let requests, authenticated, !busy, let name = Self.normalizedName(name) else { return nil }
        revealed = nil
        return execute { try await requests.mint(.init(name: name, expiresInDays: days, scope: scope)) }
            commit: { [weak self] value in self?.revealed = value.token; self?.entries.insert(value.entry, at: 0) }
    }
    @discardableResult
    public func revoke(id: String) -> Task<Void, Never>? {
        guard let requests, authenticated, canRevoke(id: id) else { return nil }
        return execute { try await requests.revoke(id) }
            commit: { [weak self] _ in self?.entries.removeAll { $0.id == id }; self?.revealed = nil }
    }
    private func execute<Value: Sendable>(
        _ operation: @escaping @Sendable () async throws -> Value,
        commit: @escaping @MainActor (Value) -> Void
    ) -> Task<Void, Never>? {
        guard !busy else { return nil }
        busy = true; error = nil
        let mine = generation
        work = Task { [weak self] in
            do {
                try Task.checkCancellation()
                let result = try await operation()
                guard let self, mine == self.generation, !Task.isCancelled else { return }
                commit(result); self.busy = false
            } catch {
                guard let self, mine == self.generation, !Task.isCancelled else { return }
                self.busy = false; self.error = L.t("native_settings_token_failed")
            }
        }
        return work
    }
    public func close() {
        generation &+= 1; work?.cancel(); work = nil
        session?.configuration.httpCookieStorage?.removeCookies(since: .distantPast)
        session?.invalidateAndCancel(); session = nil; requests = nil; activeClient = nil
        revealed = nil; entries = []; authenticated = false; busy = false; error = nil
    }
}
