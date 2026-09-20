import Foundation
import ShepherdKit
import Testing

@testable import Shepherd

// READ-ONLY against real sessions: only planGates() and planGatesInflight().
// NEVER call /go, /answer-plan-questions, /review-plan, or /quota/* here:
// they release gates or steer the operator's real agents. Writes belong in fake/contract tests.
// Authentication may mint one Shepherd UI test (…) token; every exit path revokes it.
@MainActor
struct PlanLiveTests {
    private enum LiveFailure: Error { case setup, read, revocation }

    @Test("live plan gates and inflight reviews decode, and question ids are present",
          .enabled(if: LiveServerEnvironment.configured || LiveServerEnvironment.tokenConfigured))
    func planSnapshotsDecodeAgainstTheLiveServer() async throws {
        let raw = try #require(LiveServerEnvironment.baseURL)
        let profile = try ServerProfile(
            name: "live-plan", baseURL: RemoteServerForm.normalize(raw),
            mode: .remote, credentialKey: "live-plan-\(UUID().uuidString)"
        ).validated()
        let credentials = InMemoryCredentialStore()
        var minted = false
        var revocationProbe: ShepherdClient?

        func cleanup() async throws {
            guard minted else { return } // A supplied token belongs to the caller.
            try await ProfileSetup.logout(profile: profile, credentials: credentials)
            // logout is best-effort. Prove the server actually revoked our token, using a
            // separate in-memory copy after logout has cleared the original credential.
            guard let revocationProbe else { throw LiveFailure.revocation }
            do {
                _ = try await revocationProbe.planGates()
            } catch ShepherdError.unauthenticated {
                print("live plan: minted test token revoked (401 verified)")
                return
            } catch {
                throw LiveFailure.revocation
            }
            throw LiveFailure.revocation
        }

        do {
            if let token = LiveServerEnvironment.token {
                try credentials.save(.init(token: token, tokenId: "live-plan-supplied"),
                                     for: profile.credentialKey)
            } else {
                let password = try #require(LiveServerEnvironment.password)
                let credential = try await ProfileSetup.login(
                    profile: profile, password: password, credentials: credentials,
                    tokenName: ProfileSetup.tokenName(prefix: "Shepherd UI test (",
                                                     hostName: "plan-\(UUID().uuidString)"))
                minted = true
                let probeCredentials = InMemoryCredentialStore()
                try probeCredentials.save(credential, for: profile.credentialKey)
                revocationProbe = try ShepherdClient(profile: profile, credentials: probeCredentials)
            }
            let audit = ReadOnlyRequestAudit()
            defer {
                #expect(audit.counts.reads > 0)
                #expect(audit.counts.rejected == 0, "live checks must attempt only read-only operations")
            }
            let client = try ShepherdClient(profile: profile, credentials: credentials, readOnlyAudit: audit)
            let gates = try await client.planGates()
            let inflight = try await client.planGatesInflight()
            var forms = 0
            var questions = 0
            for (id, gate) in gates {
                #expect(!id.isEmpty)
                #expect(gate.sessionId == id)
                for block in gate.blocks ?? [] {
                    guard let form = block.value13 else { continue }
                    forms += 1
                    for question in form.questions {
                        #expect(!question.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        questions += 1
                    }
                }
            }
            // Counts make an empty live snapshot explicit; it is legitimate, but does not
            // provide live question coverage. Nonempty fixtures remain covered by kit tests.
            print("live plan: \(gates.count) gates, \(inflight.count) inflight, \(forms) question forms, \(questions) question ids checked")
        } catch {
            try await cleanup()
            // Never put a URL, credential, or server payload in test failure output.
            throw minted ? LiveFailure.read : LiveFailure.setup
        }
        try await cleanup()
    }
}
