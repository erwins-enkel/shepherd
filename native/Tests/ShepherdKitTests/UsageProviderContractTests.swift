import Foundation
import Testing

@testable import ShepherdKit

@Suite("Usage provider contract", .timeLimit(.minutes(1)))
struct UsageProviderContractTests {
  private let legacy = #"""
    {"session5h":null,"week":null,"perModelWeek":[],"credits":null,
     "stale":false,"calibratedAt":null,"subscriptionOnly":false}
    """#

  private func payload(futureEnums: Bool) -> String {
    let provider = futureEnums ? "future-engine" : "codex"
    let kind = futureEnums ? "future-kind" : "tokens"
    let source = futureEnums ? "future-source" : "rollout"
    return #"""
      {"session5h":null,"week":null,"perModelWeek":[],"credits":null,
       "stale":false,"calibratedAt":null,"subscriptionOnly":false,"providers":[
        {"provider":"claude","kind":"limits","session5h":null,"week":null,
         "perModelWeek":[],"credits":null,"stale":false,"calibratedAt":null,
         "subscriptionOnly":false,"observed":{"session5h":null,
          "week":{"pct":9,"resetAt":1800500000000,"scrapedAt":1799999000000}}},
        {"provider":"\#(provider)","kind":"\#(kind)","totalTokens":120000,
         "session5hTokens":3000,"weekTokens":24000,"updatedAt":null,"stale":false,
         "session5h":null,"week":{"pct":7,"resetAt":1800500000000},
         "rateLimitSource":"\#(source)","rateLimitCheckedAt":1799999100000,
         "rateLimitFilesScanned":2,"rateLimitLatestEventAt":null}]}
      """#
  }

  @Test("usage read and event preserve both provider variants", arguments: [false, true])
  func providersDecode(futureEnums: Bool) throws {
    let limitsJSON = payload(futureEnums: futureEnums)
    let response = try JSONDecoder().decode(
      Components.Schemas.UsageLimitsResponse.self,
      from: Data(#"{"limits":\#(limitsJSON),"projections":[]}"#.utf8))
    let event = try JSONDecoder().decode(
      ServerEvent.self, from: Data(#"{"event":"usage:limits","data":\#(limitsJSON)}"#.utf8))
    guard case .usageLimits(let limits) = event else {
      Issue.record("expected usageLimits")
      return
    }
    #expect(limits == response.limits)
    let providers = try #require(limits.providers)
    #expect(providers.count == 2)
    guard case .ClaudeUsageProviderSnapshot(let claude) = providers[0],
      case .CodexUsageProviderSnapshot(let codex) = providers[1]
    else {
      Issue.record("expected Claude limits followed by Codex tokens")
      return
    }
    #expect(claude.observed?.week?.pct == 9)
    #expect(claude.session5h == nil)
    #expect(codex.totalTokens == 120_000)
    #expect(codex.session5h == nil)
    #expect(codex.week?.pct == 7)
    #expect(codex.week?.resetAt == 1_800_500_000_000)
    #expect(codex.updatedAt == nil)
    #expect(codex.rateLimitFilesScanned == 2)
    #expect(codex.rateLimitLatestEventAt == nil)
    // Unknown enum strings must survive decode and re-encode, not drop the response.
    let encoded = try JSONEncoder().encode(codex)
    let object = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    #expect(object["provider"] as? String == (futureEnums ? "future-engine" : "codex"))
    #expect(object["kind"] as? String == (futureEnums ? "future-kind" : "tokens"))
    #expect(object["rateLimitSource"] as? String == (futureEnums ? "future-source" : "rollout"))
  }

  @Test("older payloads without providers still decode on both transports")
  func noProviders() throws {
    let response = try JSONDecoder().decode(
      Components.Schemas.UsageLimitsResponse.self,
      from: Data(#"{"limits":\#(legacy),"projections":[]}"#.utf8))
    #expect(response.limits.providers == nil)
    let event = try JSONDecoder().decode(
      ServerEvent.self, from: Data(#"{"event":"usage:limits","data":\#(legacy)}"#.utf8))
    guard case .usageLimits(let limits) = event else {
      Issue.record("expected usageLimits")
      return
    }
    #expect(limits.providers == nil)
  }
}
