import Foundation
import Testing

@testable import ShepherdKit

@Suite("Generated contract types")
struct GeneratedContractTests {
  @Test("Health carries ok, version and the optional minClient")
  func healthShape() throws {
    let health = Health(ok: true, version: "1.47.0", minClient: "0.9.0")
    #expect(health.ok == true)
    #expect(health.version == "1.47.0")
    #expect(health.minClient == "0.9.0")
    #expect(Fixtures.health().minClient == nil)
  }

  @Test("nullable refs survive the derivation as optionals")
  func nullableRefsBecameOptionals() throws {
    // In the truth file these are `oneOf: [$ref, {type: "null"}]`, which the
    // generator silently drops. The derivation turns them into optional
    // plain $refs, so their presence here is the regression test.
    let session = Fixtures.session(id: "s1")
    #expect(session.sandboxApplied == nil)
    #expect(session.archiveReason == nil)
    #expect(session.experimentRole == nil)
  }

  @Test("UsageLimits keeps its nullable windows")
  func usageLimitWindowsSurvivedGeneration() throws {
    let limits = Components.Schemas.UsageLimits(
      session5h: nil, week: nil, perModelWeek: [], credits: nil,
      stale: false, calibratedAt: nil, subscriptionOnly: true
    )
    #expect(limits.session5h == nil)
    #expect(limits.credits == nil)
  }

  @Test("a known open-enum value decodes to .known and keeps its raw value")
  func openEnumKnown() throws {
    let status = try JSONDecoder().decode(SessionStatus.self, from: Data(#""running""#.utf8))
    #expect(status.known == .running)
    #expect(status.rawValue == "running")
  }

  @Test("an open-enum value this client does not know still decodes")
  func openEnumUnknown() throws {
    let status = try JSONDecoder().decode(SessionStatus.self, from: Data(#""quiescing""#.utf8))
    #expect(status.known == nil)
    #expect(status.rawValue == "quiescing")
  }

  @Test("an open enum round-trips through JSON")
  func openEnumRoundTrip() throws {
    let encoded = try JSONEncoder().encode(SessionStatus(known: .blocked))
    #expect(try JSONDecoder().decode(SessionStatus.self, from: encoded).known == .blocked)

    let unknownEncoded = try JSONEncoder().encode(SessionStatus(unknown: "quiescing"))
    #expect(try JSONDecoder().decode(SessionStatus.self, from: unknownEncoded).rawValue == "quiescing")
  }

  @Test("EventName is an open enum too")
  func eventNameIsOpen() throws {
    let known = try JSONDecoder().decode(
      Components.Schemas.EventName.self, from: Data(#""session:ready""#.utf8))
    #expect(known.rawValue == "session:ready")

    let unknown = try JSONDecoder().decode(
      Components.Schemas.EventName.self, from: Data(#""epic:progress""#.utf8))
    #expect(unknown.known == nil)
    #expect(unknown.rawValue == "epic:progress")
  }

  @Test("the public typealiases point at the generated types")
  func typealiasesResolve() {
    #expect(Session.self == Components.Schemas.Session.self)
    #expect(Settings.self == Components.Schemas.Settings.self)
    #expect(Repo.self == Components.Schemas.Repo.self)
    #expect(RepoList.self == Components.Schemas.RepoList.self)
    #expect(HeldTask.self == Components.Schemas.HeldTask.self)
    #expect(SessionStatus.self == Components.Schemas.SessionStatus.self)
    #expect(CreateSessionRequest.self == Components.Schemas.CreateSessionRequest.self)
    #expect(AgentProvider.self == Components.Schemas.AgentProvider.self)
    #expect(Effort.self == Components.Schemas.Effort.self)
    #expect(Health.self == Components.Schemas.Health.self)
    #expect(SessionStatusKnown.self == Components.Schemas.SessionStatusKnown.self)
    #expect(HerdrStateKnown.self == Components.Schemas.HerdrStateKnown.self)
    #expect(SessionArchiveReasonKnown.self == Components.Schemas.SessionArchiveReasonKnown.self)
    #expect(ExperimentRoleKnown.self == Components.Schemas.ExperimentRoleKnown.self)
    #expect(EventNameKnown.self == Components.Schemas.EventNameKnown.self)
  }

  @Test("logging uses the subsystem the spec fixes")
  func loggingSubsystem() {
    #expect(ShepherdLog.subsystem == "run.shepherd.kit")
  }
}
