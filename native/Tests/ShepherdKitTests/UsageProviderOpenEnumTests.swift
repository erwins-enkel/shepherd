import Foundation
import ShepherdKit
import Testing

@Suite("Usage provider open enums", .timeLimit(.minutes(1)))
struct UsageProviderOpenEnumTests {
  private func check<T: OpenEnum & Codable>(
    _ type: T.Type, known: T.Known, rawValue: String
  ) throws {
    let decoded = try JSONDecoder().decode(type, from: JSONEncoder().encode(rawValue))
    #expect(decoded.known == known)
    #expect(decoded.rawValue == rawValue)

    let constructed = T(known: known)
    #expect(constructed.known == known)
    #expect(constructed.rawValue == rawValue)
    #expect(try JSONDecoder().decode(type, from: JSONEncoder().encode(constructed)) == decoded)

    let futureValue = "future-\(rawValue)"
    let unknown = try JSONDecoder().decode(type, from: JSONEncoder().encode(futureValue))
    #expect(unknown.known == nil)
    #expect(unknown.rawValue == futureValue)

    let constructedUnknown = T(unknown: futureValue)
    #expect(constructedUnknown.known == nil)
    #expect(constructedUnknown.rawValue == futureValue)
    let encoded = try JSONEncoder().encode(constructedUnknown)
    #expect(try JSONDecoder().decode(String.self, from: encoded) == futureValue)
    #expect(try JSONDecoder().decode(type, from: encoded) == unknown)
  }

  @Test("Claude provider exposes known and unknown values")
  func claudeProvider() throws {
    try check(
      Components.Schemas.ClaudeUsageProviderSnapshot.ProviderPayload.self,
      known: .claude, rawValue: "claude")
  }

  @Test("Claude kind exposes known and unknown values")
  func claudeKind() throws {
    try check(
      Components.Schemas.ClaudeUsageProviderSnapshot.KindPayload.self,
      known: .limits, rawValue: "limits")
  }

  @Test("Codex provider exposes known and unknown values")
  func codexProvider() throws {
    try check(
      Components.Schemas.CodexUsageProviderSnapshot.ProviderPayload.self,
      known: .codex, rawValue: "codex")
  }

  @Test("Codex kind exposes known and unknown values")
  func codexKind() throws {
    try check(
      Components.Schemas.CodexUsageProviderSnapshot.KindPayload.self,
      known: .tokens, rawValue: "tokens")
  }

  @Test("Codex rate limit source exposes known and unknown values")
  func codexRateLimitSource() throws {
    try check(
      Components.Schemas.CodexUsageProviderSnapshot.RateLimitSourcePayload.self,
      known: .rollout, rawValue: "rollout")
    try check(
      Components.Schemas.CodexUsageProviderSnapshot.RateLimitSourcePayload.self,
      known: .missing, rawValue: "missing")
  }
}
