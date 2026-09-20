import Foundation
import Observation
import ShepherdKit
import SwiftUI

@Observable @MainActor final class SettingsTokensModel {
    private(set) var entries: [Components.Schemas.AccessTokenSummary] = []
    private(set) var revealed: String?
    private(set) var authenticated = false
    private(set) var busy = false
    private(set) var error: String?
    @ObservationIgnored private var client: ShepherdClient?
    @ObservationIgnored private var session: URLSession?
    @ObservationIgnored private var work: Task<Void,Never>?
    @ObservationIgnored private var generation = 0
    func authenticate(profile: ServerProfile, password: String, session: URLSession? = nil) {
        close()
        let transport = session ?? URLSession(configuration: .ephemeral)
        self.session = transport
        do {
            // Empty credentials: a bearer header would make this a forbidden machine request.
            client = try ShepherdClient(profile: profile, credentials: InMemoryCredentialStore(), urlSession: transport)
        } catch { self.error = L.t("native_settings_login_failed"); return }
        guard let client else { return }
        execute {
            try await client.loginForTokenAdministration(password: password)
            return try await client.listAccessTokens()
        } commit: { [weak self] in self?.entries = $0.tokens; self?.authenticated = true }
    }
    func mint(name: String, days: Components.Schemas.AccessTokenMintRequest.ExpiresInDaysPayload?, scope: Components.Schemas.TokenScope) {
        guard let client, authenticated else { return }
        revealed = nil
        execute { try await client.mintAccessToken(body: .init(name: name, expiresInDays: days, scope: scope)) }
            commit: { [weak self] value in self?.revealed = value.token; self?.entries.insert(value.entry, at: 0) }
    }
    func revoke(id: String) {
        guard let client, authenticated else { return }
        execute { try await client.revokeAccessToken(id: id) }
            commit: { [weak self] _ in self?.entries.removeAll { $0.id == id }; self?.revealed = nil }
    }
    private func execute<Value: Sendable>(
        _ operation: @escaping @Sendable () async throws -> Value,
        commit: @escaping @MainActor (Value) -> Void
    ) {
        guard !busy else { return }
        busy = true; error = nil
        let mine = generation
        work = Task { [weak self] in
            do {
                let result = try await operation()
                guard let self, mine == self.generation, !Task.isCancelled else { return }
                commit(result); self.busy = false
            } catch {
                guard let self, mine == self.generation, !Task.isCancelled else { return }
                self.busy = false; self.error = L.t("native_settings_token_failed")
            }
        }
    }
    func close() {
        generation &+= 1; work?.cancel(); work = nil
        session?.configuration.httpCookieStorage?.removeCookies(since: .distantPast)
        session?.invalidateAndCancel(); session = nil; client = nil
        revealed = nil; entries = []; authenticated = false; busy = false; error = nil
    }
}
